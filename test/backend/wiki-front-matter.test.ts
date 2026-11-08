import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { FrontMatterMetadata } from '../../src/shared/front-matter'
import {
  readWikiMetadataBatch,
  readWikiPageMetadata,
  WIKI_FRONT_MATTER_HEAD_BYTES,
  WIKI_FRONT_MATTER_MAX_BYTES,
  WIKI_METADATA_READ_CONCURRENCY,
} from '../../src/wiki/wiki-front-matter'
import { Uri } from './vscode-mock'

// Task 709 — the host head read: only the first bytes of a page are read, and only a page that
// declares front matter allocates anything. Acceptance item A9 (cost policy: head only, allocation
// only for declaring files).

// Counts the open handles of `open` from `node:fs/promises` (passthrough otherwise).
const handles = vi.hoisted(() => ({ open: 0, peak: 0, opens: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      handles.opens += 1
      handles.open += 1
      handles.peak = Math.max(handles.peak, handles.open)
      const close = handle.close.bind(handle)
      handle.close = async () => {
        handles.open -= 1
        return close()
      }
      return handle
    },
  }
})

let dir = ''
const scratch = () => Buffer.allocUnsafe(WIKI_FRONT_MATTER_HEAD_BYTES)
const write = (name: string, content: string) => {
  const file = path.join(dir, name)
  writeFileSync(file, content)
  return file
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vmde-wiki-fm-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  handles.open = 0
  handles.peak = 0
  handles.opens = 0
})

describe('readWikiPageMetadata', () => {
  it('A9 exposes the fixed byte constants', () => {
    expect(WIKI_FRONT_MATTER_HEAD_BYTES).toBe(4096)
    expect(WIKI_FRONT_MATTER_MAX_BYTES).toBe(65536)
    expect(WIKI_METADATA_READ_CONCURRENCY).toBe(16)
  })

  it('A9 returns null for a file without front matter', async () => {
    const file = write('plain.md', '# Title\n\nno front matter here\n')
    await expect(readWikiPageMetadata(file, scratch())).resolves.toBeNull()
  })

  it('A1 reads aliases and tags of a small front-matter block', async () => {
    const file = write(
      'small.md',
      '---\naliases: [Some Alias]\ntags: [x]\n---\nbody\n',
    )
    await expect(readWikiPageMetadata(file, scratch())).resolves.toEqual({
      aliases: ['Some Alias'],
      tags: ['x'],
    })
  })

  it('A9 accepts a BOM before the opening fence', async () => {
    const file = write('bom.md', '﻿---\naliases: [Bom]\n---\n')
    await expect(readWikiPageMetadata(file, scratch())).resolves.toEqual({
      aliases: ['Bom'],
      tags: [],
    })
  })

  it('A9 reads a 5,000-byte front matter (beyond the head) through the second read', async () => {
    const filler = Array.from(
      { length: 160 },
      (_, i) => `note${i}: ${'v'.repeat(20)}`,
    )
    const content = `---\n${filler.join('\n')}\naliases: [Late Alias]\n---\nbody\n`
    expect(Buffer.byteLength(content)).toBeGreaterThan(
      WIKI_FRONT_MATTER_HEAD_BYTES,
    )
    const file = write('long.md', content)
    await expect(readWikiPageMetadata(file, scratch())).resolves.toEqual({
      aliases: ['Late Alias'],
      tags: [],
    })
  })

  it('A9 returns null for a block not closed within 65,536 bytes', async () => {
    const filler = Array.from(
      { length: 4000 },
      (_, i) => `note${i}: ${'v'.repeat(20)}`,
    )
    const content = `---\naliases: [Never]\n${filler.join('\n')}\n---\n`
    expect(Buffer.byteLength(content)).toBeGreaterThan(
      WIKI_FRONT_MATTER_MAX_BYTES,
    )
    const file = write('huge.md', content)
    await expect(readWikiPageMetadata(file, scratch())).resolves.toBeNull()
  })

  it('A1 returns null for malformed YAML', async () => {
    const file = write('bad.md', '---\naliases: [A\n  b: c\n---\n')
    await expect(readWikiPageMetadata(file, scratch())).resolves.toBeNull()
  })

  it('A9 returns null for an unreadable path and logs nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const missing = path.join(dir, 'does-not-exist.md')
    await expect(readWikiPageMetadata(missing, scratch())).resolves.toBeNull()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('A9 closes the handle after a read', async () => {
    const file = write('close.md', '---\naliases: [C]\n---\n')
    await readWikiPageMetadata(file, scratch())
    expect(handles.opens).toBe(1)
    expect(handles.open).toBe(0)
  })
})

describe('readWikiMetadataBatch', () => {
  it('A9 never has more than 16 open handles and reports only declaring files', async () => {
    const batchDir = path.join(dir, 'batch')
    mkdirSync(batchDir)
    const files: Uri[] = []
    for (let i = 0; i < 60; i++) {
      const declares = i % 3 === 0
      const file = path.join(batchDir, `page-${i}.md`)
      writeFileSync(
        file,
        declares ? `---\naliases: [Alias ${i}]\n---\nbody\n` : `# Page ${i}\n`,
      )
      files.push(Uri.file(file))
    }
    const seen: Array<[string, FrontMatterMetadata]> = []
    await readWikiMetadataBatch(files, (file, metadata) =>
      seen.push([file.fsPath, metadata]),
    )
    expect(handles.opens).toBe(60)
    expect(handles.peak).toBeGreaterThan(1)
    expect(handles.peak).toBeLessThanOrEqual(WIKI_METADATA_READ_CONCURRENCY)
    expect(handles.open).toBe(0)
    expect(seen).toHaveLength(20)
    expect(seen.every(([, metadata]) => metadata.aliases.length === 1)).toBe(
      true,
    )
  })

  it('A9 stops reading further files once the token is cancelled', async () => {
    const cancelDir = path.join(dir, 'cancel')
    mkdirSync(cancelDir)
    const files: Uri[] = []
    for (let i = 0; i < 200; i++) {
      const file = path.join(cancelDir, `page-${i}.md`)
      writeFileSync(file, `---\naliases: [Alias ${i}]\n---\n`)
      files.push(Uri.file(file))
    }
    const token = { isCancellationRequested: false } as any
    let reported = 0
    await readWikiMetadataBatch(
      files,
      () => {
        reported += 1
        if (reported === 5) token.isCancellationRequested = true
      },
      token,
    )
    expect(reported).toBeGreaterThanOrEqual(5)
    expect(handles.opens).toBeLessThan(200)
  })

  it('A9 reads nothing for an already cancelled token', async () => {
    const file = write('pre-cancel.md', '---\naliases: [A]\n---\n')
    const onMetadata = vi.fn()
    await readWikiMetadataBatch([Uri.file(file)], onMetadata, {
      isCancellationRequested: true,
    } as any)
    expect(handles.opens).toBe(0)
    expect(onMetadata).not.toHaveBeenCalled()
  })
})
