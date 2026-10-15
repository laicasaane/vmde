import { beforeEach, describe, expect, it } from 'vitest'
import {
  collectWikiMarkdownFiles,
  getWikiDocumentContext,
  getWikiRoot,
  isWikiFile,
  isWikiPageExcluded,
} from '../../src/wiki/wiki'
import { FileType, mock, Uri, workspace } from './vscode-mock'

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

const F = FileType.File
const D = FileType.Directory

describe('wiki', () => {
  beforeEach(() => {
    mock.reset()
    mock.setWorkspaceFolder('/ws')
    mock.setConfig({ enabled: true, root: '' })
  })

  describe('getWikiRoot', () => {
    it('returns the workspace root when enabled with empty root', () => {
      const root = getWikiRoot(Uri.file('/ws/docs/Page.md'))
      expect(root?.fsPath).toBe('/ws')
    })
    it('returns the configured subfolder when root is set', () => {
      mock.setConfig({ enabled: true, root: 'docs/wiki' })
      const root = getWikiRoot(Uri.file('/ws/docs/wiki/Page.md'))
      expect(root?.fsPath).toBe('/ws/docs/wiki')
    })
    it('returns undefined when disabled', () => {
      mock.setConfig({ enabled: false })
      expect(getWikiRoot(Uri.file('/ws/Page.md'))).toBeUndefined()
    })
    it('returns undefined for non-markdown files', () => {
      expect(getWikiRoot(Uri.file('/ws/note.txt'))).toBeUndefined()
    })
    it('returns undefined for a non-file scheme', () => {
      expect(getWikiRoot(Uri.parse('untitled:/ws/x.md'))).toBeUndefined()
    })
    it('returns undefined when file has no workspace folder', () => {
      workspace.getWorkspaceFolder.mockReturnValueOnce(undefined)
      expect(getWikiRoot(Uri.file('/orphan/Page.md'))).toBeUndefined()
    })
  })

  describe('isWikiFile', () => {
    it('is true for a markdown file when wiki is enabled', () => {
      expect(isWikiFile(Uri.file('/ws/Page.md'))).toBe(true)
    })
    it('is false when disabled', () => {
      mock.setConfig({ enabled: false })
      expect(isWikiFile(Uri.file('/ws/Page.md'))).toBe(false)
    })
    it('is false for non-md and undefined', () => {
      expect(isWikiFile(Uri.file('/ws/note.txt'))).toBe(false)
      expect(isWikiFile(undefined)).toBe(false)
    })
  })

  describe('getWikiDocumentContext', () => {
    it('is enabled with a root label when wiki is on', () => {
      const ctx = getWikiDocumentContext(Uri.file('/ws/Page.md'))
      expect(ctx.enabled).toBe(true)
      expect(ctx.rootLabel).toBeTruthy()
    })
    it('is disabled when wiki is off or for undefined', () => {
      mock.setConfig({ enabled: false })
      expect(getWikiDocumentContext(Uri.file('/ws/x.md')).enabled).toBe(false)
      expect(getWikiDocumentContext(undefined).enabled).toBe(false)
    })
  })

  describe('collectWikiMarkdownFiles', () => {
    it('recursively collects .md/.markdown and skips other files', async () => {
      mountFs({
        '/ws': [
          ['Home.md', F],
          ['readme.markdown', F],
          ['note.txt', F],
          ['sub', D],
        ],
        '/ws/sub': [['Deep.md', F]],
      })
      const files = await collectWikiMarkdownFiles(Uri.file('/ws'))
      expect(files.map((f) => f.fsPath).sort()).toEqual([
        '/ws/Home.md',
        '/ws/readme.markdown',
        '/ws/sub/Deep.md',
      ])
    })

    it('returns [] when the wiki root is missing (configured path deleted) — no throw', async () => {
      // `vmde.wiki.root` points at a directory that no longer exists: the search finds nothing.
      mountFs({ '/ws': [['Home.md', F]] })
      await expect(
        collectWikiMarkdownFiles(Uri.file('/ws/gone')),
      ).resolves.toEqual([])
    })

    it('returns [] instead of throwing when the search itself fails', async () => {
      mock.setFindFiles(async () => {
        throw new Error('search service unavailable')
      })
      await expect(collectWikiMarkdownFiles(Uri.file('/ws'))).resolves.toEqual(
        [],
      )
    })
  })
})

// Task 638 — `vmde.wiki.exclude` (Owner decision 2026-10-15: a way to exclude folders and files by
// relative path, absolute path or pattern). Each entry joins the same exclude set the page search
// and the file watcher use, so for every case the files the search returns must be exactly the files
// the watcher predicate (`isWikiPageExcluded`) does not exclude.
describe('vmde.wiki.exclude (task 638)', () => {
  const WIKI_EXCLUDE = 'vmde.wiki.exclude'
  const FILES = [
    '/ws/Keep.md',
    '/ws/Secret.md',
    '/ws/drafts/A.md',
    '/ws/drafts/deep/B.md',
    '/ws/private/C.md',
    '/ws/sub/tmp/D.md',
    '/ws/tmp/E.md',
    '/ws/other/F.md',
    '/ws/other/G.markdown',
  ]
  const ROOT = Uri.file('/ws')

  beforeEach(() => {
    mock.reset()
    mock.setWorkspaceFolder('/ws')
    mock.setConfig({ enabled: true, root: '' })
    mock.setWorkspaceFiles(FILES)
  })

  // Runs the search and the watcher predicate for `root` and returns the files each one keeps.
  async function keptBy(root: Uri, files: string[]) {
    const found = await collectWikiMarkdownFiles(root)
    const bySearch = found.map((file) => file.fsPath).sort()
    const byWatcher = files
      .filter((file) => file.startsWith(`${root.fsPath}/`))
      .filter((file) => !isWikiPageExcluded(root, Uri.file(file)))
      .sort()
    return { bySearch, byWatcher }
  }

  async function expectExcluded(
    entries: unknown,
    excluded: string[],
    root = ROOT,
    files = FILES,
  ) {
    mock.setConfig({ [WIKI_EXCLUDE]: entries })
    const { bySearch, byWatcher } = await keptBy(root, files)
    const expected = files
      .filter((file) => file.startsWith(`${root.fsPath}/`))
      .filter((file) => !excluded.includes(file))
      .sort()
    expect(bySearch).toEqual(expected)
    expect(byWatcher).toEqual(expected)
  }

  it('no entries (the default) excludes nothing', async () => {
    await expectExcluded([], [])
  })

  it('a relative file path excludes that file', async () => {
    await expectExcluded(['Secret.md'], ['/ws/Secret.md'])
  })

  it('a relative folder path excludes the folder and everything under it', async () => {
    await expectExcluded(
      ['drafts'],
      ['/ws/drafts/A.md', '/ws/drafts/deep/B.md'],
    )
  })

  it('a trailing slash and a leading ./ on a folder path make no difference', async () => {
    await expectExcluded(
      ['./drafts/'],
      ['/ws/drafts/A.md', '/ws/drafts/deep/B.md'],
    )
  })

  it('an absolute folder path inside the workspace folder is converted to workspace-relative', async () => {
    await expectExcluded(['/ws/private'], ['/ws/private/C.md'])
  })

  it('an absolute file path inside the workspace folder excludes that file', async () => {
    await expectExcluded(['/ws/Secret.md'], ['/ws/Secret.md'])
  })

  it('an absolute path outside the workspace folder is ignored', async () => {
    await expectExcluded(['/elsewhere/drafts', '/wsx/private'], [])
  })

  it('a **/ glob excludes at any depth', async () => {
    await expectExcluded(['**/tmp/**'], ['/ws/sub/tmp/D.md', '/ws/tmp/E.md'])
  })

  it('a workspace-relative glob matches only at its own depth', async () => {
    await expectExcluded(['drafts/*.md'], ['/ws/drafts/A.md'])
  })

  it('brace and character-class globs work', async () => {
    await expectExcluded(
      ['{Secret,Keep}.md', 'other/[FG].*'],
      [
        '/ws/Secret.md',
        '/ws/Keep.md',
        '/ws/other/F.md',
        '/ws/other/G.markdown',
      ],
    )
  })

  it('Windows separators are normalized (relative folder, relative glob, absolute folder)', async () => {
    await expectExcluded(
      ['drafts\\deep', 'sub\\tmp\\*.md', '\\ws\\private'],
      ['/ws/drafts/deep/B.md', '/ws/sub/tmp/D.md', '/ws/private/C.md'],
    )
  })

  it('an uncompilable glob matches nothing, a valid entry still excludes, and nothing throws', async () => {
    await expectExcluded(['{a,b', 'Secret.md'], ['/ws/Secret.md'])
  })

  it('empty, blank and non-string entries are ignored without throwing', async () => {
    await expectExcluded(
      ['', '   ', 5, null, {}, 'Secret.md'],
      ['/ws/Secret.md'],
    )
  })

  it('a value that is not an array is ignored', async () => {
    await expectExcluded('Secret.md', [])
    await expectExcluded({ 'Secret.md': true }, [])
  })

  it('the entries are merged with files.exclude and node_modules', async () => {
    mock.setWorkspaceFiles([...FILES, '/ws/node_modules/pkg/R.md'])
    mock.setConfig({ exclude: { '**/private/**': true } })
    await expectExcluded(
      ['Secret.md'],
      ['/ws/Secret.md', '/ws/private/C.md', '/ws/node_modules/pkg/R.md'],
      ROOT,
      [...FILES, '/ws/node_modules/pkg/R.md'],
    )
  })

  describe('wiki root in a subfolder (entries are rebased to the root)', () => {
    const DOCS = Uri.file('/ws/docs')
    const DOC_FILES = [
      '/ws/docs/Keep.md',
      '/ws/docs/drafts/A.md',
      '/ws/docs/tmp/E.md',
      '/ws/docs/notes/N.md',
      '/ws/drafts/Outside.md',
    ]

    beforeEach(() => {
      mock.setWorkspaceFiles(DOC_FILES)
      mock.setConfig({ root: 'docs' })
    })

    it('a path written from the workspace folder excludes inside the root', async () => {
      await expectExcluded(
        ['docs/drafts'],
        ['/ws/docs/drafts/A.md'],
        DOCS,
        DOC_FILES,
      )
    })

    it('a folder name outside the root does not exclude a same-named folder inside it', async () => {
      await expectExcluded(['drafts'], [], DOCS, DOC_FILES)
    })

    it('an absolute path inside the root is rebased', async () => {
      await expectExcluded(
        ['/ws/docs/tmp'],
        ['/ws/docs/tmp/E.md'],
        DOCS,
        DOC_FILES,
      )
    })

    it('a relative glob and a **/ glob are rebased', async () => {
      await expectExcluded(
        ['docs/notes/*.md', '**/tmp/**'],
        ['/ws/docs/notes/N.md', '/ws/docs/tmp/E.md'],
        DOCS,
        DOC_FILES,
      )
    })
  })
})
