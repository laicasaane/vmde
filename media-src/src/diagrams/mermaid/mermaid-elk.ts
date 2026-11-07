// Task 112 — opt-in ELK layout for mermaid GRAPH diagrams (flowchart / class / state / ER), an
// alternative to mermaid's default dagre. mermaid ≥10.3 made layout pluggable: register layout loaders,
// then `layout: "elk"` (globally via config, or per-diagram via `%%{init:{"layout":"elk"}}%%`) resolves.
//
// KEY DESIGN — no first-render race. mermaid AWAITS a loader's `loader()` before it renders, so we
// register the (tiny) loader DEFINITIONS SYNCHRONOUSLY the moment mermaid loads (from mermaid-theme.ts's
// window.mermaid hook), for EVERY mermaid doc. A dagre diagram never invokes a loader → nothing heavy
// loads (lazy preserved). An ELK diagram makes mermaid await our loader(), which lazy-loads the vendored
// @mermaid-js/layout-elk render chunk (mermaid-elk-main.js) + boots the shared main-thread elkjs
// (window.__vmdeElk — the stock blob Worker is rejected by the VS Code webview, ADR-0004) and returns
// the render module. Because mermaid awaits it, the FIRST render is already ELK — no dagre-first flash,
// no settle re-render, no source pre-scan. Kept dependency-light (boot-elk + load-script only) so nothing
// heavy re-enters the eager main.js and undoes the task-165 code-split.
import { bootElk } from '../d2/boot-elk'
import { loadScript } from '../../util/load-script'

declare const window: Window & {
  mermaid?: { registerLayoutLoaders?: (loaders: unknown) => void }
  __vmdeMermaidElkLayouts?: Array<{ loader: () => Promise<unknown> }>
  __vmdeMermaidElkRegistered?: boolean
  __vmdeCdn?: string
}

// The mermaid ELK layout algorithms exposed by @mermaid-js/layout-elk 0.2.2. Mirrored here (stable list)
// so registration is a SYNCHRONOUS eager step — the render chunk that implements them stays lazy.
const ELK_ALGORITHMS: Array<{ name: string; algorithm: string }> = [
  { name: 'elk', algorithm: 'elk.layered' },
  { name: 'elk.stress', algorithm: 'elk.stress' },
  { name: 'elk.force', algorithm: 'elk.force' },
  { name: 'elk.mrtree', algorithm: 'elk.mrtree' },
  { name: 'elk.sporeOverlap', algorithm: 'elk.sporeOverlap' },
]

// The lazy loader mermaid awaits before rendering an ELK diagram: load the adapter bundle + boot the
// shared ELK, then hand back the vendored render module (all vendored entries share ONE render chunk, so
// [0].loader() yields the `{ render }` module for every algorithm — our per-entry `algorithm` above tells
// the render which ELK algorithm to run). Throws if the adapter can't load: mermaid does NOT fall back
// to dagre then, the whole render rejects (task 705 probe 3), so the block shows this message in the
// error box. Any rejection on the way (script, shared ELK boot, vendored loader) maps to it.
async function loadElkRenderModule(): Promise<unknown> {
  try {
    const ok = await ensureMermaidElk(window.__vmdeCdn ?? '')
    const vendored = window.__vmdeMermaidElkLayouts
    if (!ok || !vendored?.[0]) throw new Error('adapter missing')
    return recordingModule(await vendored[0].loader())
  } catch {
    throw new Error('ELK layout failed to load.')
  }
}

// Task 705: direct evidence of which diagrams the ELK engine really drew. mermaid exposes no registry
// query and silently falls back to dagre when `elk` is unregistered, so wrap the vendored render module:
// `render(data, ...)` records `data.diagramId` (equal to the id given to mermaid.render, probe 3) and the
// patched mermaidRender asks takeElkRender(id) after the render. Bounded so ids never accumulate.
const drawnByElk = new Set<string>()
const MAX_DRAWN_IDS = 256
function recordingModule(mod: unknown): unknown {
  const m = mod as {
    render?: (data: { diagramId?: string }, ...rest: unknown[]) => unknown
  } | null
  if (!m || typeof m.render !== 'function') return mod
  const render = m.render
  return {
    ...m,
    render(data: { diagramId?: string }, ...rest: unknown[]) {
      if (data?.diagramId) {
        if (drawnByElk.size >= MAX_DRAWN_IDS) drawnByElk.clear()
        drawnByElk.add(data.diagramId)
      }
      return render.call(m, data, ...rest)
    },
  }
}

/** True once per render id the ELK engine drew (consumes the record). */
export function takeElkRender(id: string): boolean {
  return drawnByElk.delete(id)
}

// Register the ELK layout loaders on the mermaid global. MUST be called AFTER mermaid.initialize()
// completes (mermaid-theme.ts calls it from inside the initialize wrapper, after the original init):
// mermaid lazily (re)initialises its layout-algorithm registry — the `y2 = {}` reset in mermaid's own
// module init runs on the first initialize and WIPES an earlier registration (verified: registering in
// the window.mermaid load hook left `layout:'elk'` falling back to dagre; re-registering right before
// render fixed it, task 112). mermaid's registerLayoutLoaders is a plain `y2[name] = entry` overwrite —
// no dupes, no warning — so re-running it on every initialize is cheap + safe. Registering these tiny
// definitions pulls NOTHING heavy: the render chunk + elkjs load only when mermaid awaits
// loadElkRenderModule for an actual ELK diagram.
export function registerMermaidElkLoaders(): boolean {
  // Called from the initialize wrapper, which also runs in node unit tests (fake window) — `typeof`
  // guards the ReferenceError before touching the real global.
  if (typeof window === 'undefined') return false
  const m = window.mermaid
  if (!m || typeof m.registerLayoutLoaders !== 'function') return false
  m.registerLayoutLoaders(
    ELK_ALGORITHMS.map((a) => ({
      name: a.name,
      algorithm: a.algorithm,
      loader: loadElkRenderModule,
    })),
  )
  window.__vmdeMermaidElkRegistered = true
  return true
}

let readyPromise: Promise<boolean> | null = null

// Load the ELK adapter bundle (→ window.__vmdeMermaidElkLayouts) AND boot the shared main-thread ELK
// (→ window.__vmdeElk) in parallel. Cached: one fetch per session; on failure the cache is cleared so
// a later render can retry. Awaited by loadElkRenderModule (i.e. lazily, the first time an ELK diagram
// renders), and directly by the live-flip re-render in diagram-retheme.ts.
export function ensureMermaidElk(cdn: string): Promise<boolean> {
  if (!readyPromise) {
    readyPromise = (async () => {
      const [, elk] = await Promise.all([
        loadScript(
          `${cdn}/dist/js/mermaid-layout-elk/mermaid-elk-main.js`,
          'vditorMermaidElkScript',
        ),
        bootElk(cdn),
      ])
      if (!window.__vmdeMermaidElkLayouts || !elk) {
        readyPromise = null
        return false
      }
      return true
    })()
  }
  return readyPromise
}
