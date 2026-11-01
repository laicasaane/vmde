// Custom diagram renderers for languages Vditor doesn't natively support.
// Each renderer: lazy-loads the engine script, finds unprocessed code blocks,
// replaces them with rendered SVG. Themed via currentColor (same as graphviz/plantuml).

import { PREVIEW_BLOCK_RELEASED_EVENT } from '../diagram-kit/diagram-dom'
import { engineLangs } from '../diagram-kit/engine-registry'
// Task 409 split this god-module into one file per engine (`engines/<engine>.ts`) plus the shared
// DOM plumbing (`diagram-dom.ts`). This file is no longer a transitional facade for the split
// itself (409 closed, every engine migrated, every real importer of './custom-diagrams' resolves
// the engine it actually needs) — it's now the shared DISPATCHER: it imports each engine's
// render/reRender to build CUSTOM_DIAGRAM_ADAPTERS and drive observeCustomDiagrams below, and it
// re-exports the two symbols `diagram-retheme.ts` still consumes through this path
// (CUSTOM_DIAGRAM_ADAPTERS, reRenderD2, reRenderVega — task 498 dropped the rest as dead
// re-exports nothing outside this file imports anymore).
import { renderStl, reRenderStl } from './engines/stl'
import { renderWavedrom, reRenderWavedrom } from './engines/wavedrom'
import { renderNomnoml, reRenderNomnoml } from './engines/nomnoml'
import {
  renderGeojson,
  renderTopojson,
  reRenderGeojson,
  reRenderTopojson,
} from './engines/geojson-topojson'
import { renderVega, renderVegaLite, reRenderVega } from './engines/vega'
export { reRenderVega } from './engines/vega'
import {
  isTyping,
  deferUntilSettle,
  beginSettleRender,
  scheduleReveal,
} from '../editing/edit-activity'
import { renderD2, reRenderD2 } from './d2/engines/d2'
import {
  HOIST_SCOPE_CHANGE_EVENT,
  isSectionHoistHidden,
} from '../util/source-map'
import { classifyAndRecordEditorSurfaceMutations } from '../util/mutation-impact'
export { reRenderD2 } from './d2/engines/d2'

// Task 404 phase 1 — inert scaffolding, nothing calls this map yet. `engine-registry.ts` is
// documented PURE DATA (must import nothing from engine modules), so this per-lang function
// map lives HERE instead, keyed to match ENGINES' `family: 'custom'` set; a completeness test
// (custom-diagrams.test.ts) asserts the two stay in sync in both directions — the concrete
// mechanism that makes a forgotten adapter for a new custom engine fail a test instead of
// silently never rendering. 'vega-lite' maps to reRenderVega (not a separate function): task
// 400 found renderVegaBlock always resets/renders vega + vega-lite together in one pass.
interface CustomDiagramAdapter {
  render: (root?: ParentNode) => void
  reRender: (root?: ParentNode) => void
}

export const CUSTOM_DIAGRAM_ADAPTERS: Record<string, CustomDiagramAdapter> = {
  wavedrom: { render: renderWavedrom, reRender: reRenderWavedrom },
  nomnoml: { render: renderNomnoml, reRender: reRenderNomnoml },
  geojson: { render: renderGeojson, reRender: reRenderGeojson },
  topojson: { render: renderTopojson, reRender: reRenderTopojson },
  vega: { render: renderVega, reRender: reRenderVega },
  'vega-lite': { render: renderVegaLite, reRender: reRenderVega },
  stl: { render: renderStl, reRender: reRenderStl },
  d2: { render: renderD2, reRender: reRenderD2 },
}

// Task 404 phase 2 — observeCustomDiagrams' per-lang dispatch list, DERIVED from the registry +
// CUSTOM_DIAGRAM_ADAPTERS instead of a second hand-maintained `{lang, render}` array (this file
// used to carry both, byte-for-byte in sync only by discipline — the exact "fixed it in N of N+1
// copies" risk the registry exists to prevent). Order follows ENGINES' family:'custom' rows
// (wavedrom, nomnoml, geojson, topojson, vega, vega-lite, stl, d2), matching the array this
// replaces; a unit test pins both the order and that each entry IS the adapter's `render` fn (not
// a copy), so the two can never drift again.
export function customDiagramRenderers(): {
  lang: string
  render: (root: ParentNode) => void
}[] {
  return engineLangs((e) => e.family === 'custom').map((lang) => ({
    lang,
    render: CUSTOM_DIAGRAM_ADAPTERS[lang].render,
  }))
}

async function renderCustomRoots(
  roots: readonly ParentNode[],
  renderers: ReturnType<typeof customDiagramRenderers>,
): Promise<void> {
  for (const root of roots) {
    const present = presentCustomLangs(root)
    for (const { lang, render } of renderers) {
      if (!present.has(lang)) continue
      render(root)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      )
    }
  }
}

// --- Observer: render all custom diagrams on DOM mutations ---

/** The set of `language-<lang>` slugs with an UN-rendered block under `root`. A deliberate SUPERSET
 *  of findBlocks' selector — no edit-surface `.closest(...)` filter — so it drives which engines
 *  observeCustomDiagrams invokes (task 164 §5) WITHOUT risking a dropped diagram: a false positive
 *  (a lang present only in an editable marker) just degrades to a renderer no-op (findBlocks skips
 *  the marker), whereas a false negative would silently drop a real diagram. */
export function presentCustomLangs(root: ParentNode): Set<string> {
  const present = new Set<string>()
  for (const el of Array.from(
    root.querySelectorAll<HTMLElement>(
      'code[class*="language-"]:not([data-processed="true"]), div[class*="language-"]:not([data-processed="true"])',
    ),
  )) {
    if (isSectionHoistHidden(el)) continue
    for (const cls of Array.from(el.classList)) {
      if (cls.startsWith('language-')) {
        present.add(cls.slice('language-'.length))
        break
      }
    }
  }
  return present
}

export function observeCustomDiagrams(
  appEl: HTMLElement | null | undefined,
): () => void {
  // No editor root mounted yet — nothing to observe; hand back a no-op
  // disposer so callers can always call the returned teardown unconditionally.
  if (!appEl)
    return () => {
      /* no-op disposer */
    }
  // lang-tagged so the pre-scan in run() can invoke + yield a frame for ONLY the engines a doc
  // actually uses (task 164 §5), instead of walking all 8 every sweep. Task 404 phase 2: derived
  // from CUSTOM_DIAGRAM_ADAPTERS (see customDiagramRenderers) instead of a second hard-coded list.
  const renderers = customDiagramRenderers()
  let raf = 0
  let running = false
  let dirty = false
  let pendingFull = true
  const pendingBlocks = new Set<HTMLElement>()
  const takeRoots = (): ParentNode[] => {
    const blocks = [...pendingBlocks]
    const roots =
      pendingFull || blocks.some((block) => !block.isConnected)
        ? [appEl]
        : blocks
    pendingFull = false
    pendingBlocks.clear()
    return roots
  }
  // Render each custom-diagram engine, YIELDING a frame between them, so the burst doesn't monopolise
  // the single main thread. Measured (task 145 follow-up, perf-timeline.spec): when all engines ran in
  // one synchronous rAF, hljs execution + Vditor's highlightRender (code colouring) were starved until
  // every diagram finished (~4.8 s on a 15-diagram doc). Yielding lets the colouring + paint interleave.
  // Idempotent (each renderer skips data-processed); re-entrant-safe via running/dirty so mutations
  // arriving mid-pass trigger exactly one more pass, not overlapping ones.
  const run = () => {
    if (running) {
      dirty = true
      return
    }
    void (async () => {
      running = true
      do {
        dirty = false
        // Pre-scan ONCE which custom langs actually have an un-rendered block, then invoke + yield a
        // frame ONLY for those (task 164 §5). Before this, all 8 renderers yielded a frame even with
        // zero blocks — a D2-only doc's first paint waited behind ~7 empty-renderer frame boundaries,
        // and a no-diagram doc churned 8 querySelectorAlls per sweep. Empty engines are now a
        // synchronous skip (no yield). Re-computed each do-while pass (data-processed shrinks it).
        await renderCustomRoots(takeRoots(), renderers)
      } while (dirty || pendingFull || pendingBlocks.size > 0)
      running = false
    })()
  }
  // Check isTyping in schedule() (it runs on EVERY mutation, regardless of run()'s running/dirty state)
  // so a burst is always deferred — even if an OPEN-path render is still looping. While the user types
  // in a diagram's source, defer the whole pass to the edit-activity settle: the cached overlay keeps
  // the last SVG visible meanwhile (task 161 step 1). On settle, prep canvas previews (cover mode),
  // render the latest source, and start the swap-when-ready reveal watcher. The OPEN path / theme
  // re-renders aren't typing → they render promptly via the rAF path below.
  const collectImpact = (records?: MutationRecord[]): boolean => {
    const batch = records ?? []
    const classified = classifyAndRecordEditorSurfaceMutations(
      'custom-diagrams',
      batch,
    )
    if (!classified) return false
    const { impact, pass } = classified
    if (pass === 'skipped') return false
    if (impact.full) pendingFull = true
    if (!pendingFull)
      for (const block of impact.blocks) pendingBlocks.add(block)
    return true
  }
  const schedule = (records?: MutationRecord[]) => {
    if (!collectImpact(records)) return
    if (isTyping()) {
      deferUntilSettle('custom-diagrams', () => {
        beginSettleRender()
        run()
        scheduleReveal()
      })
      return
    }
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0
        run()
      })
    }
  }
  const obs = new MutationObserver((records) => schedule(records))
  obs.observe(appEl, { childList: true, subtree: true })
  // Hoist exit changes attributes only, which the renderer observer deliberately does not watch.
  // The controller's scoped event re-scans newly visible blocks without widening mutation cost.
  const onHoistScopeChange = (event: Event): void => {
    const active = (event as CustomEvent<{ active?: boolean }>).detail?.active
    if (active !== true) schedule()
  }
  document.addEventListener(HOIST_SCOPE_CHANGE_EVENT, onHoistScopeChange)
  // Task 643: full Preview holds far-off-screen blocks back (findBlocks skips them). A released
  // block gains no DOM mutation the observer above would see, so scan exactly that block now.
  const onPreviewBlockReleased = (event: Event): void => {
    const block = (event as CustomEvent<{ block?: HTMLElement }>).detail?.block
    if (!block || !appEl.contains(block)) return
    pendingBlocks.add(block)
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0
        run()
      })
    }
  }
  document.addEventListener(
    PREVIEW_BLOCK_RELEASED_EVENT,
    onPreviewBlockReleased,
  )
  schedule()
  return () => {
    obs.disconnect()
    document.removeEventListener(HOIST_SCOPE_CHANGE_EVENT, onHoistScopeChange)
    document.removeEventListener(
      PREVIEW_BLOCK_RELEASED_EVENT,
      onPreviewBlockReleased,
    )
    if (raf) cancelAnimationFrame(raf)
    running = false
  }
}
