import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isLuteArtifactBuilt, warnLuteArtifactMissing } from './lute-artifact'

// Task 641 fix 4 (Owner decision: "go with cache code"): the host loads the 3.7 MB Lute script
// with a V8 code cache kept in the extension's global storage. Each case boots the real Lute
// build artifact in a fresh module instance, so the module-level Lute singleton starts cold.
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const LUTE_BUILT = isLuteArtifactBuilt(ROOT)
if (!LUTE_BUILT) warnLuteArtifactMissing('lute host code cache', ROOT)

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const h = vi.hoisted(() => ({
  forceRejected: false,
  scripts: [] as Array<{
    options: { cachedData?: Buffer } | undefined
    script: { cachedDataRejected?: boolean }
  }>,
}))
vi.mock('node:vm', async (importOriginal) => {
  const vm = await importOriginal<typeof import('node:vm')>()
  class Script extends vm.Script {
    constructor(code: string, options?: import('node:vm').ScriptOptions) {
      super(code, options)
      // One test process is one V8 isolate: after the first load, V8's in-memory compilation cache
      // serves the same source again and never consults `cachedData`, so V8 cannot reject a corrupt
      // cache here. The rejection case forces the flag V8 would set in a fresh extension host.
      if (h.forceRejected)
        Object.defineProperty(this, 'cachedDataRejected', { value: true })
      h.scripts.push({
        options: options as { cachedData?: Buffer } | undefined,
        script: this,
      })
    }
  }
  const mocked = { ...vm, Script }
  return { ...mocked, default: mocked }
})

type LuteHost = typeof import('../../src/lute/lute-host')

async function freshHost(): Promise<LuteHost> {
  vi.resetModules()
  return import('../../src/lute/lute-host')
}

const SAMPLE = '# Title\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'

function cacheDir(storage: string): string {
  return path.join(storage, 'lute-code-cache')
}

function cacheFiles(storage: string): string[] {
  const dir = cacheDir(storage)
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.bin'))
    : []
}

// Loads Lute through a production entry point (a full-document canonicalization).
function load(host: LuteHost): string | undefined {
  return host.canonicalizeIrMarkdown(ROOT, SAMPLE)
}

describe.skipIf(!LUTE_BUILT)('host Lute code cache (Task 641 fix 4)', () => {
  let storage: string

  beforeEach(() => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), 'vmde-lute-cache-'))
    h.scripts.length = 0
    h.forceRejected = false
  })
  afterEach(() => {
    fs.rmSync(storage, { recursive: true, force: true })
  })

  it('writes the cache after the first load and passes it as cachedData on the next load (acceptance: cache hit)', async () => {
    const first = await freshHost()
    first.configureLuteCodeCache(storage, '1.0.0')
    const uncached = load(first)
    expect(h.scripts[0].options?.cachedData).toBeUndefined()
    expect(cacheFiles(storage)).toEqual([])
    expect(await first.flushLuteCodeCacheWrite()).toBe(true)
    expect(cacheFiles(storage)).toHaveLength(1)
    // Only the cache folder is created in the storage directory; no temporary file is left.
    expect(fs.readdirSync(storage)).toEqual(['lute-code-cache'])
    expect(fs.readdirSync(cacheDir(storage))).toEqual(cacheFiles(storage))

    const second = await freshHost()
    second.configureLuteCodeCache(storage, '1.0.0')
    const cached = load(second)
    const [file] = cacheFiles(storage)
    expect(h.scripts[1].options?.cachedData).toEqual(
      fs.readFileSync(path.join(cacheDir(storage), file)),
    )
    // No Lute behaviour change: the same output with and without the cache.
    expect(cached).toBe(uncached)
    expect(cached).toBeTypeOf('string')
    // A hit does not rewrite the cache.
    expect(await second.flushLuteCodeCacheWrite()).toBe(false)
  })

  it('rebuilds and rewrites the cache when the key changes, dropping the old entry (edge: key mismatch)', async () => {
    const first = await freshHost()
    first.configureLuteCodeCache(storage, '1.0.0')
    load(first)
    await first.flushLuteCodeCacheWrite()
    const [oldFile] = cacheFiles(storage)

    const upgraded = await freshHost()
    upgraded.configureLuteCodeCache(storage, '1.0.1')
    load(upgraded)
    expect(h.scripts[1].options?.cachedData).toBeUndefined()
    expect(await upgraded.flushLuteCodeCacheWrite()).toBe(true)
    const files = cacheFiles(storage)
    expect(files).toHaveLength(1)
    expect(files[0]).not.toBe(oldFile)
  })

  it('replaces a corrupt cache that V8 rejects (edge: rejection)', async () => {
    const first = await freshHost()
    first.configureLuteCodeCache(storage, '1.0.0')
    load(first)
    await first.flushLuteCodeCacheWrite()
    const file = path.join(cacheDir(storage), cacheFiles(storage)[0])
    fs.writeFileSync(file, Buffer.from('not a V8 code cache'))

    const second = await freshHost()
    second.configureLuteCodeCache(storage, '1.0.0')
    h.forceRejected = true
    expect(load(second)).toBeTypeOf('string')
    expect(h.scripts[1].options?.cachedData).toEqual(
      Buffer.from('not a V8 code cache'),
    )
    expect(await second.flushLuteCodeCacheWrite()).toBe(true)
    expect(fs.readFileSync(file).length).toBeGreaterThan(1024)
    expect(cacheFiles(storage)).toHaveLength(1)
  })

  it('ignores and replaces an oversize cache file without reading it (edge: oversize)', async () => {
    const first = await freshHost()
    first.configureLuteCodeCache(storage, '1.0.0')
    load(first)
    await first.flushLuteCodeCacheWrite()
    const file = path.join(cacheDir(storage), cacheFiles(storage)[0])
    fs.truncateSync(file, 200 * 1024 * 1024) // sparse: no real disk use

    const second = await freshHost()
    second.configureLuteCodeCache(storage, '1.0.0')
    expect(load(second)).toBeTypeOf('string')
    expect(h.scripts[1].options?.cachedData).toBeUndefined()
    expect(await second.flushLuteCodeCacheWrite()).toBe(true)
    expect(fs.statSync(file).size).toBeLessThan(200 * 1024 * 1024)
  })

  it('falls back silently when the storage is unusable (edge: disk errors)', async () => {
    // The storage path is a regular file: reading and creating the cache folder both fail.
    const blocked = path.join(storage, 'not-a-directory')
    fs.writeFileSync(blocked, 'x')
    const host = await freshHost()
    host.configureLuteCodeCache(blocked, '1.0.0')
    expect(load(host)).toBeTypeOf('string')
    expect(h.scripts[0].options?.cachedData).toBeUndefined()
    await expect(host.flushLuteCodeCacheWrite()).resolves.toBe(false)
    expect(fs.readFileSync(blocked, 'utf8')).toBe('x')

    // The cache file path is a directory: unreadable, so it is ignored and the load still works.
    const other = path.join(storage, 'other')
    const second = await freshHost()
    second.configureLuteCodeCache(other, '1.0.0')
    load(second)
    await second.flushLuteCodeCacheWrite()
    const file = path.join(cacheDir(other), cacheFiles(other)[0])
    fs.rmSync(file)
    fs.mkdirSync(file)
    const third = await freshHost()
    third.configureLuteCodeCache(other, '1.0.0')
    expect(load(third)).toBeTypeOf('string')
    expect(h.scripts[2].options?.cachedData).toBeUndefined()
    await expect(third.flushLuteCodeCacheWrite()).resolves.toBe(false)
  })

  it('uses no cache, and writes nowhere, without the extension global storage (edge: storage only)', async () => {
    const host = await freshHost()
    host.configureLuteCodeCache(undefined, '1.0.0')
    expect(load(host)).toBeTypeOf('string')
    expect(h.scripts[0].options?.cachedData).toBeUndefined()
    // No write is pending: there is no fallback location such as the system temp folder.
    expect(await host.flushLuteCodeCacheWrite()).toBe(false)
  })
})
