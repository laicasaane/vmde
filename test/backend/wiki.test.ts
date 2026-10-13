import { beforeEach, describe, expect, it } from 'vitest'
import {
  collectWikiMarkdownFiles,
  getWikiDocumentContext,
  getWikiRoot,
  isWikiFile,
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
