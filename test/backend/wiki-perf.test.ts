import { beforeEach, describe, expect, it } from 'vitest'
import { collectWikiMarkdownFiles } from '../../src/wiki/wiki'
import {
  WikiCache,
  _resetCacheMap,
  getOrBuildCache,
} from '../../src/wiki/wiki-cache'
import { mock, Uri } from './vscode-mock'

// Performance characterization of the wiki page-scan path. These tests don't
// assert wall-clock times (flaky on CI) — they COUNT the host calls the scan makes.
// Task 636 replaced the serial directory walk (one fs.readDirectory per directory, O(dirs))
// with ONE workspace.findFiles search, so the scan cost no longer grows with the directory
// count: every scan is one search call and zero directory reads.

// Build a virtual wiki with `nDirs` subdirectories, each containing `filesPerDir`
// markdown files. Returns the file list and its size.
function buildLargeWiki(nDirs: number, filesPerDir: number) {
  const files: string[] = []
  for (let d = 0; d < nDirs; d++) {
    const dirName = `section-${String(d).padStart(3, '0')}`
    for (let f = 0; f < filesPerDir; f++) {
      files.push(`/ws/wiki/${dirName}/page-${String(f).padStart(3, '0')}.md`)
    }
  }
  return { files, totalFiles: files.length }
}

describe('wiki scan performance characterization', () => {
  let readDirCallCount: number
  const searchCount = () => mock.calls.findFiles.length

  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
    mock.setWorkspaceFolder('/ws')
    readDirCallCount = 0
  })

  function mountAndCount(files: string[]) {
    mock.setReadDirectory(async () => {
      readDirCallCount++
      return []
    })
    mock.setWorkspaceFiles(files)
  }

  describe('collectWikiMarkdownFiles — one search, independent of directory count', () => {
    it('small wiki (5 dirs × 10 files = 50 files): one search, no directory reads', async () => {
      const { files, totalFiles } = buildLargeWiki(5, 10)
      mountAndCount(files)

      const found = await collectWikiMarkdownFiles(Uri.file('/ws/wiki'))

      expect(found).toHaveLength(totalFiles)
      expect(searchCount()).toBe(1)
      expect(readDirCallCount).toBe(0)
    })

    it('medium wiki (50 dirs × 20 files = 1000 files): one search, no directory reads', async () => {
      const { files, totalFiles } = buildLargeWiki(50, 20)
      mountAndCount(files)

      const found = await collectWikiMarkdownFiles(Uri.file('/ws/wiki'))

      expect(found).toHaveLength(totalFiles)
      expect(searchCount()).toBe(1)
      expect(readDirCallCount).toBe(0)
    })

    it('large wiki (200 dirs × 50 files = 10000 files): one search, no directory reads', async () => {
      const { files, totalFiles } = buildLargeWiki(200, 50)
      mountAndCount(files)

      const found = await collectWikiMarkdownFiles(Uri.file('/ws/wiki'))

      expect(found).toHaveLength(totalFiles)
      expect(searchCount()).toBe(1)
      expect(readDirCallCount).toBe(0)
    })
  })

  describe('WikiCache — cached lookups eliminate repeated scans', () => {
    it('first build scans once, subsequent has/resolve = 0 searches', async () => {
      const { files } = buildLargeWiki(50, 20)
      mountAndCount(files)

      const cache = await WikiCache.build(Uri.file('/ws/wiki'))
      const afterBuild = searchCount()

      // 1000 resolve lookups — zero additional scans
      for (let i = 0; i < 1000; i++) {
        cache.has(`section-${String(i % 50).padStart(3, '0')}/page-000`)
        cache.resolve(`page-${String(i % 20).padStart(3, '0')}`)
      }
      expect(searchCount()).toBe(afterBuild) // unchanged

      cache.dispose()
      expect(afterBuild).toBe(1) // one scan total
      expect(readDirCallCount).toBe(0)
    })

    it('getOrBuildCache: second editor open = 0 scans', async () => {
      const { files } = buildLargeWiki(10, 10)
      mountAndCount(files)

      await getOrBuildCache(Uri.file('/ws/wiki'))
      const afterFirst = searchCount()

      await getOrBuildCache(Uri.file('/ws/wiki'))
      expect(searchCount()).toBe(afterFirst) // no re-scan
      expect(afterFirst).toBe(1)
    })
  })
})
