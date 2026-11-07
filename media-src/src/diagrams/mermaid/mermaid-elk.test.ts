import { afterEach, describe, expect, it, vi } from 'vitest'

// mermaid-elk.ts (task 112) touches real globals (window/document via loadScript + bootElk) and holds a
// module-level `readyPromise` cache — so each test resets the module graph and installs fake globals.

// A fake DOM whose head.appendChild fires the script's onload on the next microtask (loadScript resolves
// on onload). Records which script ids were appended so a test can assert what got loaded.
function installFakeDom() {
  const appended: string[] = []
  const byId = new Map<string, any>()
  const document = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: () => ({}) as any,
    head: {
      appendChild: (s: any) => {
        byId.set(s.id, s)
        appended.push(s.id)
        queueMicrotask(() => s.onload?.())
      },
    },
  }
  ;(globalThis as any).document = document
  return { appended }
}

describe('registerMermaidElkLoaders', () => {
  afterEach(() => {
    ;(globalThis as any).window = undefined
  })

  it('no-ops without a real window (node unit context)', async () => {
    ;(globalThis as any).window = undefined
    vi.resetModules()
    const { registerMermaidElkLoaders } = await import('./mermaid-elk')
    expect(() => registerMermaidElkLoaders()).not.toThrow()
  })

  it('registers the 5 ELK layout loaders synchronously with name/algorithm/loader', async () => {
    const registerLayoutLoaders = vi.fn()
    ;(globalThis as any).window = { mermaid: { registerLayoutLoaders } } as any
    vi.resetModules()
    const { registerMermaidElkLoaders } = await import('./mermaid-elk')

    registerMermaidElkLoaders()
    expect(registerLayoutLoaders).toHaveBeenCalledTimes(1)

    const loaders = registerLayoutLoaders.mock.calls[0][0]
    expect(loaders.map((l: any) => l.name)).toEqual([
      'elk',
      'elk.stress',
      'elk.force',
      'elk.mrtree',
      'elk.sporeOverlap',
    ])
    // The default 'elk' entry maps to the layered algorithm; every entry carries a loader thunk.
    expect(loaders[0].algorithm).toBe('elk.layered')
    expect(loaders.every((l: any) => typeof l.loader === 'function')).toBe(true)
    expect((globalThis as any).window.__vmdeMermaidElkRegistered).toBe(true)
  })

  it('re-registers on every call (a safe overwrite — mermaid resets its registry on each initialize)', async () => {
    const registerLayoutLoaders = vi.fn()
    ;(globalThis as any).window = { mermaid: { registerLayoutLoaders } } as any
    vi.resetModules()
    const { registerMermaidElkLoaders } = await import('./mermaid-elk')
    registerMermaidElkLoaders()
    registerMermaidElkLoaders()
    // No idempotence guard: each initialize must re-assert the loaders (mermaid wipes them). GP just
    // overwrites y2[name], so repeated calls are cheap + dup-free.
    expect(registerLayoutLoaders).toHaveBeenCalledTimes(2)
  })

  it('no-ops when the mermaid global lacks registerLayoutLoaders', async () => {
    ;(globalThis as any).window = { mermaid: {} } as any
    vi.resetModules()
    const { registerMermaidElkLoaders } = await import('./mermaid-elk')
    expect(() => registerMermaidElkLoaders()).not.toThrow()
    expect((globalThis as any).window.__vmdeMermaidElkRegistered).toBeFalsy()
  })

  it('a registered loader() lazy-loads the adapter and returns the vendored render module', async () => {
    const registerLayoutLoaders = vi.fn()
    const vendoredLoader = vi.fn().mockResolvedValue({ render: 'RENDER_FN' })
    // Pre-seed the globals the loaded scripts would install (loadScript only fires onload; it does not
    // run real bundle bytes) so ensureMermaidElk sees the loaders array + the shared ELK instance.
    ;(globalThis as any).window = {
      mermaid: { registerLayoutLoaders },
      __vmdeCdn: 'CDN',
      __vmdeMermaidElkLayouts: [{ loader: vendoredLoader }],
      __vmdeElk: { layout: vi.fn() },
    } as any
    const { appended } = installFakeDom()
    vi.resetModules()
    const { registerMermaidElkLoaders } = await import('./mermaid-elk')

    registerMermaidElkLoaders()
    const loaders = registerLayoutLoaders.mock.calls[0][0]
    // mermaid AWAITS this before rendering an ELK diagram.
    const mod = await loaders[0].loader()
    expect(mod).toEqual({ render: 'RENDER_FN' })
    expect(vendoredLoader).toHaveBeenCalledTimes(1)
    // It went through the lazy load: both the adapter bundle and the shared elk-main.js were fetched.
    expect(appended).toContain('vditorMermaidElkScript')
    expect(appended).toContain('vditorElkScript')
  })

  it('a registered loader() rejects with the report-friendly message when the shared ELK never boots (task 705 F3: an error, not a dagre fallback)', async () => {
    const registerLayoutLoaders = vi.fn()
    ;(globalThis as any).window = {
      mermaid: { registerLayoutLoaders },
      __vmdeCdn: 'CDN',
      __vmdeMermaidElkLayouts: [{ loader: vi.fn() }],
      // no __vmdeElk → bootElk gives up → ensureMermaidElk false → loadElkRenderModule throws.
    } as any
    installFakeDom()
    vi.resetModules()
    const { registerMermaidElkLoaders } = await import('./mermaid-elk')
    registerMermaidElkLoaders()
    const loaders = registerLayoutLoaders.mock.calls[0][0]
    vi.useFakeTimers()
    const p = loaders[0].loader()
    // Attach a rejection handler synchronously so draining timers doesn't surface an unhandled rejection.
    const settled = expect(p).rejects.toThrow('ELK layout failed to load.')
    await vi.runAllTimersAsync()
    vi.useRealTimers()
    await settled
  })
})

// Task 705 (Proposed work 5, F3, F2 evidence) — acceptance: ELK loaders registered on every render path,
// a failing ELK load is a visible error, and a fallback to dagre is detectable.
describe('registerMermaidElkLoaders return value (task 705)', () => {
  afterEach(() => {
    ;(globalThis as any).window = undefined
  })

  it('returns true after registering', async () => {
    ;(globalThis as any).window = {
      mermaid: { registerLayoutLoaders: vi.fn() },
    } as any
    vi.resetModules()
    const { registerMermaidElkLoaders } = await import('./mermaid-elk')
    expect(registerMermaidElkLoaders()).toBe(true)
  })

  it('returns false without a window, without mermaid, or without registerLayoutLoaders', async () => {
    vi.resetModules()
    ;(globalThis as any).window = undefined
    const mod = await import('./mermaid-elk')
    expect(mod.registerMermaidElkLoaders()).toBe(false)
    ;(globalThis as any).window = {} as any
    expect(mod.registerMermaidElkLoaders()).toBe(false)
    ;(globalThis as any).window = { mermaid: {} } as any
    expect(mod.registerMermaidElkLoaders()).toBe(false)
  })
})

describe('ELK render-module wrapper (task 705, fallback evidence)', () => {
  afterEach(() => {
    ;(globalThis as any).window = undefined
    ;(globalThis as any).document = undefined
  })

  async function loadedModule() {
    const registerLayoutLoaders = vi.fn()
    const vendoredRender = vi.fn().mockResolvedValue('drawn')
    ;(globalThis as any).window = {
      mermaid: { registerLayoutLoaders },
      __vmdeCdn: 'CDN',
      __vmdeMermaidElkLayouts: [
        {
          loader: vi
            .fn()
            .mockResolvedValue({ render: vendoredRender, extra: 1 }),
        },
      ],
      __vmdeElk: { layout: vi.fn() },
    } as any
    installFakeDom()
    vi.resetModules()
    const mod = (await import(
      './mermaid-elk'
    )) as typeof import('./mermaid-elk') & {
      // Task 705 export, absent until Part 2b lands (typed here so the suite compiles while RED).
      takeElkRender(id: string): boolean
    }
    mod.registerMermaidElkLoaders()
    const loaders = registerLayoutLoaders.mock.calls[0][0]
    const wrapped = (await loaders[0].loader()) as {
      render: (...a: unknown[]) => Promise<unknown>
    }
    return { mod, wrapped, vendoredRender }
  }

  it('delegates render() to the vendored module with the same arguments and result', async () => {
    const { wrapped, vendoredRender } = await loadedModule()
    const data = { diagramId: 'mermaid-1' }
    await expect(wrapped.render(data, 'a', 'b')).resolves.toBe('drawn')
    expect(vendoredRender).toHaveBeenCalledWith(data, 'a', 'b')
  })

  it('records data.diagramId and takeElkRender consumes it exactly once', async () => {
    const { mod, wrapped } = await loadedModule()
    expect(mod.takeElkRender('mermaid-1')).toBe(false)
    await wrapped.render({ diagramId: 'mermaid-1' })
    expect(mod.takeElkRender('mermaid-1')).toBe(true)
    expect(mod.takeElkRender('mermaid-1')).toBe(false)
  })

  it('bounds the recorded set: the oldest ids are dropped after more than 256', async () => {
    const { mod, wrapped } = await loadedModule()
    for (let i = 0; i < 300; i++) await wrapped.render({ diagramId: `id-${i}` })
    expect(mod.takeElkRender('id-0')).toBe(false)
    expect(mod.takeElkRender('id-299')).toBe(true)
  })
})

describe('ensureMermaidElk', () => {
  afterEach(() => {
    ;(globalThis as any).window = undefined
    ;(globalThis as any).document = undefined
  })

  it('loads the adapter bundle + boots the shared ELK, then caches (one fetch)', async () => {
    ;(globalThis as any).window = {
      __vmdeMermaidElkLayouts: [{ loader: vi.fn() }],
      __vmdeElk: { layout: vi.fn() },
    } as any
    const { appended } = installFakeDom()
    vi.resetModules()
    const { ensureMermaidElk } = await import('./mermaid-elk')

    expect(await ensureMermaidElk('CDN')).toBe(true)
    expect(appended).toContain('vditorMermaidElkScript')
    expect(appended).toContain('vditorElkScript')

    // Cached: a second call re-fetches nothing.
    appended.length = 0
    expect(await ensureMermaidElk('CDN')).toBe(true)
    expect(appended).toEqual([])
  })

  it('returns false and clears the cache when the shared ELK never comes up (retry allowed)', async () => {
    // No __vmdeElk on window → bootElk polls then gives up → ensureMermaidElk fails.
    ;(globalThis as any).window = {
      __vmdeMermaidElkLayouts: [{ loader: vi.fn() }],
    } as any
    installFakeDom()
    vi.resetModules()
    const { ensureMermaidElk } = await import('./mermaid-elk')
    vi.useFakeTimers()
    const p = ensureMermaidElk('CDN')
    await vi.runAllTimersAsync()
    vi.useRealTimers()
    expect(await p).toBe(false)
  })
})
