import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { debug, initLogger } from '../../src/platform/host-log'
import {
  clearStoredKeys,
  configureWikiKeyStore,
  readStoredKeys,
  writeStoredKeys,
} from '../../src/wiki/wiki-key-store'
import { mock, Uri } from './vscode-mock'

// Task 638 — the persisted wiki page list (acceptance 5: bounded, schema-versioned, an unreadable or
// old entry is ignored). Expected values come from the task contract: one workspace-state key per
// root (`vmde.wikiPages:<root uri string>`), schema version 1, no limit on the number of pages, at
// most 4 MiB of UTF-8 string bytes per list (Owner decision 2026-10-15), at most 4 stored roots per
// workspace.

const PREFIX = 'vmde.wikiPages:'
const ROOT = Uri.file('/ws')
const ROOT_KEY = `${PREFIX}${ROOT.toString()}`
const MAX_BYTES = 4 * 1024 * 1024
// The earlier provisional entry cap; the Owner removed the page-count limit, so a list over it is
// stored when it fits the byte cap.
const OLD_ENTRY_CAP = 20_000

// An in-memory Memento with the three members the store may use. `keys` can be left out to model a
// context without it.
function makeMemento(options: { withKeys?: boolean } = {}) {
  const data: Record<string, unknown> = {}
  const memento: {
    data: Record<string, unknown>
    get: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    keys?: ReturnType<typeof vi.fn>
  } = {
    data,
    get: vi.fn((key: string) => data[key]),
    update: vi.fn(async (key: string, value: unknown) => {
      if (value === undefined) delete data[key]
      else data[key] = value
    }),
  }
  if (options.withKeys !== false) memento.keys = vi.fn(() => Object.keys(data))
  return memento
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const entry = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  root: ROOT.toString(),
  savedAt: 1_700_000_000_000,
  pageKeys: ['alpha', 'beta'],
  displayNames: ['Alpha', 'Beta'],
  ...overrides,
})

// `count` distinct strings of `size` ASCII characters (so `count * size` bytes).
const ascii = (count: number, size: number) =>
  Array.from({ length: count }, (_, i) => String(i).padEnd(size, 'x'))

describe('wiki-key-store (task 638)', () => {
  let memento: ReturnType<typeof makeMemento>

  beforeEach(() => {
    mock.reset()
    memento = makeMemento()
    configureWikiKeyStore(memento as any)
  })

  afterEach(() => {
    configureWikiKeyStore(undefined)
    vi.useRealTimers()
  })

  describe('round trip (A5)', () => {
    it('writes one entry per root with the exact version-1 schema and reads it back', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(1_700_000_000_000))
      const keys = { pageKeys: ['a', 'b'], displayNames: ['A', 'B'] }

      writeStoredKeys(ROOT, keys)
      await flush()

      expect(memento.data[ROOT_KEY]).toEqual({
        version: 1,
        root: 'file:///ws',
        savedAt: 1_700_000_000_000,
        pageKeys: ['a', 'b'],
        displayNames: ['A', 'B'],
      })
      expect(Object.keys(memento.data)).toEqual([ROOT_KEY])
      expect(readStoredKeys(ROOT)).toEqual(keys)
    })

    it('keeps different roots under different keys', async () => {
      writeStoredKeys(ROOT, { pageKeys: ['a'], displayNames: ['A'] })
      writeStoredKeys(Uri.file('/ws/alpha'), {
        pageKeys: ['b'],
        displayNames: ['B'],
      })
      await flush()

      expect(readStoredKeys(ROOT)?.pageKeys).toEqual(['a'])
      expect(readStoredKeys(Uri.file('/ws/alpha'))?.pageKeys).toEqual(['b'])
      expect(readStoredKeys(Uri.file('/ws/other'))).toBeUndefined()
    })

    it('clearStoredKeys deletes the entry for that root only', async () => {
      writeStoredKeys(ROOT, { pageKeys: ['a'], displayNames: ['A'] })
      writeStoredKeys(Uri.file('/ws/alpha'), {
        pageKeys: ['b'],
        displayNames: ['B'],
      })
      await flush()

      clearStoredKeys(ROOT)
      await flush()

      expect(readStoredKeys(ROOT)).toBeUndefined()
      expect(readStoredKeys(Uri.file('/ws/alpha'))).toBeDefined()
    })
  })

  describe('unreadable, old, wrong-root or oversize entries are ignored (A5, schema upgrade)', () => {
    const ignored: Array<[string, unknown]> = [
      ['an old schema version', entry({ version: 0 })],
      ['a future schema version', entry({ version: 2 })],
      ['a version stored as a string', entry({ version: '1' })],
      ['a missing version', entry({ version: undefined })],
      ['a root of another workspace folder', entry({ root: 'file:///other' })],
      ['a missing root', entry({ root: undefined })],
      ['a non-finite savedAt (NaN)', entry({ savedAt: Number.NaN })],
      ['a non-finite savedAt (Infinity)', entry({ savedAt: Infinity })],
      ['a savedAt stored as a string', entry({ savedAt: '1700000000000' })],
      ['pageKeys that is not an array', entry({ pageKeys: 'alpha' })],
      ['displayNames that is not an array', entry({ displayNames: {} })],
      ['a non-string pageKeys element', entry({ pageKeys: ['alpha', 7] })],
      ['a non-string displayNames element', entry({ displayNames: [null] })],
      ['an empty-string pageKeys element', entry({ pageKeys: ['alpha', ''] })],
      ['an empty-string displayNames element', entry({ displayNames: [''] })],
      ['an empty page list', entry({ pageKeys: [], displayNames: [] })],
      ['null', null],
      ['a string', 'alpha,beta'],
      ['a number', 42],
      ['an array', [entry()]],
    ]

    it.each(ignored)('%s', (_label, value) => {
      memento.data[ROOT_KEY] = value
      expect(readStoredKeys(ROOT)).toBeUndefined()
    })

    it('a hand-written list over the byte cap is ignored', () => {
      // 4 MiB of keys plus a single one-byte display name: one byte over.
      memento.data[ROOT_KEY] = entry({
        pageKeys: ascii(MAX_BYTES / 4096, 4096),
        displayNames: ['x'],
      })
      expect(readStoredKeys(ROOT)).toBeUndefined()
    })

    it('a list of more than 20,000 pages within the byte cap is read (no page-count limit)', () => {
      const pageKeys = ascii(26_000, 150)
      memento.data[ROOT_KEY] = entry({
        pageKeys,
        displayNames: ascii(26_000, 7),
      })
      expect(readStoredKeys(ROOT)?.pageKeys).toHaveLength(26_000)
    })

    it('a list exactly at the byte cap is read', () => {
      // 1,023 keys of 4,096 bytes + one of 4,095 + the one-byte display name = exactly 4 MiB.
      const pageKeys = [...ascii(1023, 4096), 'y'.repeat(4095)]
      memento.data[ROOT_KEY] = entry({ pageKeys, displayNames: ['x'] })
      expect(readStoredKeys(ROOT)?.pageKeys).toHaveLength(1024)
    })

    it('an unreadable value never throws on read and is not repaired by the read', () => {
      memento.get.mockImplementation(() => {
        throw new Error('corrupt state database')
      })
      expect(() => readStoredKeys(ROOT)).not.toThrow()
      expect(readStoredKeys(ROOT)).toBeUndefined()
      expect(memento.update).not.toHaveBeenCalled()
    })

    it('an ignored entry is overwritten by the next write', async () => {
      memento.data[ROOT_KEY] = entry({ version: 2 })
      writeStoredKeys(ROOT, { pageKeys: ['fresh'], displayNames: ['Fresh'] })
      await flush()
      expect(readStoredKeys(ROOT)).toEqual({
        pageKeys: ['fresh'],
        displayNames: ['Fresh'],
      })
    })
  })

  describe('bounds on write (A5)', () => {
    it('stores a list of about 3.9 MiB and more than 20,000 pages (Owner: up to 4 MiB, no page limit)', async () => {
      // 26,000 keys of 150 bytes + 26,000 display names of 7 bytes = 4,082,000 bytes (3.89 MiB).
      const pageKeys = ascii(26_000, 150)
      const displayNames = ascii(26_000, 7)
      expect(pageKeys.length).toBeGreaterThan(OLD_ENTRY_CAP)
      writeStoredKeys(ROOT, { pageKeys, displayNames })
      await flush()
      expect(readStoredKeys(ROOT)).toEqual({ pageKeys, displayNames })
    })

    it('stores a list exactly at 4 MiB', async () => {
      // 1,023 keys of 4,096 bytes + one of 4,095 + the one-byte display name = exactly 4 MiB.
      const exactBytes = [...ascii(1023, 4096), 'y'.repeat(4095)]
      writeStoredKeys(ROOT, { pageKeys: exactBytes, displayNames: ['x'] })
      await flush()
      expect(readStoredKeys(ROOT)?.pageKeys).toHaveLength(1024)
    })

    it('does not store more than 4 MiB of string bytes, and deletes the old entry', async () => {
      writeStoredKeys(ROOT, { pageKeys: ['small'], displayNames: ['Small'] })
      await flush()
      expect(readStoredKeys(ROOT)).toBeDefined()

      // One byte over: 4 MiB of keys plus a single one-byte display name.
      writeStoredKeys(ROOT, {
        pageKeys: ascii(MAX_BYTES / 4096, 4096),
        displayNames: ['x'],
      })
      await flush()

      expect(readStoredKeys(ROOT)).toBeUndefined()
      expect(ROOT_KEY in memento.data).toBe(false)
    })

    it('does not store an oversize display-name array either', async () => {
      writeStoredKeys(ROOT, { pageKeys: ['small'], displayNames: ['Small'] })
      await flush()

      writeStoredKeys(ROOT, {
        pageKeys: ['x'],
        displayNames: ascii(MAX_BYTES / 4096, 4096),
      })
      await flush()

      expect(readStoredKeys(ROOT)).toBeUndefined()
      expect(ROOT_KEY in memento.data).toBe(false)
    })

    it('counts UTF-8 bytes, not characters (non-ASCII page names)', async () => {
      // 700 names of 2,000 three-byte characters: 1,400,000 characters (under 4 M), 4,200,000 bytes
      // (over 4 MiB = 4,194,304).
      const names = Array.from({ length: 700 }, (_, i) =>
        `${i}`.padEnd(2000, 'あ'),
      )
      writeStoredKeys(ROOT, { pageKeys: names, displayNames: ['x'] })
      await flush()
      expect(readStoredKeys(ROOT)).toBeUndefined()

      // Same characters, within the byte cap: stored and read back unchanged.
      const small = names.slice(0, 50).map((n) => n.slice(0, 1000))
      writeStoredKeys(ROOT, { pageKeys: small, displayNames: ['x'] })
      await flush()
      expect(readStoredKeys(ROOT)?.pageKeys).toEqual(small)
    })

    it('does not store an empty list and deletes the entry (an empty result may be a failed search)', async () => {
      writeStoredKeys(ROOT, { pageKeys: ['a'], displayNames: ['A'] })
      await flush()

      writeStoredKeys(ROOT, { pageKeys: [], displayNames: [] })
      await flush()

      expect(readStoredKeys(ROOT)).toBeUndefined()
      expect(ROOT_KEY in memento.data).toBe(false)
    })
  })

  describe('at most 4 stored roots per workspace (A5)', () => {
    const rootN = (n: number) => Uri.file(`/ws/root${n}`)

    it('a third and a fourth root evict nothing', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      for (let n = 1; n <= 4; n++) {
        vi.setSystemTime(new Date(1_700_000_000_000 + n * 1000))
        writeStoredKeys(rootN(n), {
          pageKeys: [`p${n}`],
          displayNames: [`P${n}`],
        })
        await flush()
      }
      for (let n = 1; n <= 4; n++)
        expect(readStoredKeys(rootN(n))).toBeDefined()
    })

    it('a fifth root evicts the entry with the oldest savedAt', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      // Saved out of numeric order so the oldest is not the first or the last written.
      const savedAt = [3000, 1000, 4000, 2000]
      for (let n = 1; n <= 4; n++) {
        vi.setSystemTime(new Date(1_700_000_000_000 + savedAt[n - 1]))
        writeStoredKeys(rootN(n), {
          pageKeys: [`p${n}`],
          displayNames: [`P${n}`],
        })
        await flush()
      }

      vi.setSystemTime(new Date(1_700_000_000_000 + 9000))
      writeStoredKeys(rootN(5), { pageKeys: ['p5'], displayNames: ['P5'] })
      await flush()

      expect(readStoredKeys(rootN(2))).toBeUndefined()
      for (const n of [1, 3, 4, 5])
        expect(readStoredKeys(rootN(n))).toBeDefined()
    })

    it('rewriting a stored root is not a new root and evicts nothing', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      for (let n = 1; n <= 4; n++) {
        vi.setSystemTime(new Date(1_700_000_000_000 + n * 1000))
        writeStoredKeys(rootN(n), {
          pageKeys: [`p${n}`],
          displayNames: [`P${n}`],
        })
        await flush()
      }

      vi.setSystemTime(new Date(1_700_000_000_000 + 9000))
      writeStoredKeys(rootN(1), {
        pageKeys: ['again'],
        displayNames: ['Again'],
      })
      await flush()

      for (let n = 1; n <= 4; n++)
        expect(readStoredKeys(rootN(n))).toBeDefined()
      expect(readStoredKeys(rootN(1))?.pageKeys).toEqual(['again'])
    })

    it('entries stored by an earlier extension-host lifetime count towards the cap', async () => {
      for (let n = 1; n <= 4; n++) {
        memento.data[`${PREFIX}${rootN(n).toString()}`] = entry({
          root: rootN(n).toString(),
          savedAt: 1_700_000_000_000 + n * 1000,
        })
      }
      // Unrelated workspace-state keys are neither counted nor deleted.
      memento.data['vmde.foldState:file:///ws/note.md'] = { headings: [] }

      writeStoredKeys(rootN(5), { pageKeys: ['p5'], displayNames: ['P5'] })
      await flush()

      expect(readStoredKeys(rootN(1))).toBeUndefined()
      expect(readStoredKeys(rootN(2))).toBeDefined()
      expect(memento.data['vmde.foldState:file:///ws/note.md']).toEqual({
        headings: [],
      })
    })

    it('a memento without keys() skips pruning and still stores', async () => {
      const bare = makeMemento({ withKeys: false })
      configureWikiKeyStore(bare as any)
      for (let n = 1; n <= 5; n++) {
        writeStoredKeys(rootN(n), {
          pageKeys: [`p${n}`],
          displayNames: [`P${n}`],
        })
        await flush()
      }
      for (let n = 1; n <= 5; n++)
        expect(readStoredKeys(rootN(n))).toBeDefined()
    })
  })

  describe('failure and privacy (no page keys, names or paths in logs)', () => {
    const SECRET_PAGE = 'confidential-merger-plan'
    const SECRET_PATH = '/ws/private-client'

    function captureLog() {
      const channel = vscode.window.createOutputChannel('VMDE', {
        log: true,
      })
      initLogger(channel as any)
      configureWikiKeyStore(memento as any, debug)
      return () =>
        (mock.calls as any).outputChannels.flatMap((c: any) =>
          c.logs.map((l: any) => l.message),
        ) as string[]
    }

    it('a rejecting update neither throws nor logs a key, a display name or a path, and keeps the previous entry', async () => {
      const logs = captureLog()
      writeStoredKeys(Uri.file(SECRET_PATH), {
        pageKeys: ['older'],
        displayNames: ['Older'],
      })
      await flush()
      memento.update.mockImplementation(() =>
        Promise.reject(
          new Error(`disk full writing ${SECRET_PAGE} ${SECRET_PATH}`),
        ),
      )

      expect(() =>
        writeStoredKeys(Uri.file(SECRET_PATH), {
          pageKeys: [SECRET_PAGE],
          displayNames: [SECRET_PAGE],
        }),
      ).not.toThrow()
      expect(() => clearStoredKeys(Uri.file(SECRET_PATH))).not.toThrow()
      await flush()

      // The failure is logged as one generic line, so these checks are not vacuous.
      expect(logs().length).toBeGreaterThan(0)
      for (const line of logs()) {
        expect(line).not.toContain(SECRET_PAGE)
        expect(line).not.toContain(SECRET_PATH)
        expect(line).not.toContain('private-client')
      }
      // The failed write left the previous entry in place.
      expect(readStoredKeys(Uri.file(SECRET_PATH))?.pageKeys).toEqual(['older'])
    })

    it('an update that throws synchronously neither throws out of the store nor logs a key', async () => {
      const logs = captureLog()
      memento.update.mockImplementation(() => {
        throw new Error(`cannot write ${SECRET_PAGE}`)
      })

      expect(() =>
        writeStoredKeys(ROOT, {
          pageKeys: [SECRET_PAGE],
          displayNames: [SECRET_PAGE],
        }),
      ).not.toThrow()
      await flush()

      expect(logs().length).toBeGreaterThan(0)
      for (const line of logs()) expect(line).not.toContain(SECRET_PAGE)
    })
  })

  describe('unconfigured store', () => {
    it('is a no-op: nothing to read, writes and clears do nothing and never throw', async () => {
      configureWikiKeyStore(undefined)

      expect(readStoredKeys(ROOT)).toBeUndefined()
      expect(() =>
        writeStoredKeys(ROOT, { pageKeys: ['a'], displayNames: ['A'] }),
      ).not.toThrow()
      expect(() => clearStoredKeys(ROOT)).not.toThrow()
      await flush()

      expect(memento.update).not.toHaveBeenCalled()
      expect(readStoredKeys(ROOT)).toBeUndefined()
    })
  })
})
