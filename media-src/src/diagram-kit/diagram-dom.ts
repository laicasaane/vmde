// Shared DOM plumbing for the custom-diagram engines (wavedrom, nomnoml, geojson, topojson,
// vega/vega-lite, stl, d2 — task 409, splitting `custom-diagrams.ts`'s god-module into one file
// per engine). This module holds only what MORE THAN ONE engine needs: the cdn accessor, the
// preview-pane selector, the code→div swap (`findBlocks`), and the shared reset step
// (`resetCustomBlocks`, task 400). Engine-specific helpers (theming, script loaders, per-engine
// state) stay in that engine's own `diagram-engines/<engine>.ts` file.

import { isSectionHoistHidden } from '../util/source-map'

declare const window: Window & {
  vditor?: { options?: { cdn?: string } }
}

export function getCdn(): string {
  const v = window.vditor as any
  return v?.vditor?.options?.cdn ?? v?.options?.cdn ?? ''
}

export const PANE_SEL =
  '.vditor-ir__preview, .vditor-wysiwyg__preview, .vditor-preview'

// NATIVE_PANE_SEL (the two split-mode preview classes only, excluding `.vditor-preview`) USED to
// live here and be what the native-family retheme paths (mermaid/plantuml/echarts/native-offscreen)
// scanned — task 412's own confirmed-HIGH bug: the full/split Preview surface is a SIBLING of the
// active mode's editable pane, not a descendant, so a root resolved from `activeModeElement` never
// even reached `.vditor-preview`'s diagrams, and this narrower selector compounded it for the
// engines that used it. Retired — every retheme path now scans `diagram-surfaces.ts`'s
// `renderedDiagramTargets` (which includes `.vditor-preview`) from a root resolved by
// `diagramRenderRoot` (the stable `#app` mount, an ancestor of every surface). See
// diagram-surfaces.ts's own header comment for the full story.

// The DOM ancestor wrapping exactly ONE rendered block (one preview pane) — one level above the
// pane itself, so `scope.querySelectorAll(PANE_SEL)` finds just that pane. Task 412: every
// re-render function in both engine families (reRenderLang, resetCustomBlocks+renderX, reRenderD2,
// reRenderEcharts) already scans `container.querySelectorAll(PANE_SEL-or-similar)` — so calling one
// of them with THIS as `container` instead of the whole editor scopes the reset+redraw to a SINGLE
// diagram, which is exactly what viewport-gating a per-element candidate needs, with no change to
// any of those functions. Empirically verified (task 412 pre-check, real webview): even two fenced
// diagram blocks inside the SAME blockquote/list item resolve to SEPARATE `.vditor-ir__node` /
// `.vditor-wysiwyg__block` wrappers — Lute nests one per top-level block, not one per container —
// so this never accidentally scopes to more than the one diagram. `parentElement` is the fallback
// for the full "Preview" overlay mode, which wraps rendered content in plain markdown-body markup
// rather than an IR/WYSIWYG block node (mirrors the same closest()+fallback idiom already used to
// find a diagram's source sibling in diagram-surfaces.ts's nativeSourceForLive).
const BLOCK_WRAPPER_SEL =
  '.vditor-ir__node, .vditor-wysiwyg__block, [data-type="code-block"]'

export function blockScopeOf(live: HTMLElement): HTMLElement {
  return (
    live.closest<HTMLElement>(BLOCK_WRAPPER_SEL) ?? live.parentElement ?? live
  )
}

// The render cache stamps each block with the theme key its CURRENT markup was produced under
// (render-cache-client's `put`), and refuses to report a block whose stamp is stale — that is what
// stops a pre-flip render being filed under the post-flip key. The two places that hand a block to
// an engine for a REDRAW are the two below, so they are where the stamp is dropped; the name is
// defined here because both live in this module. Read (and re-set) only by render-cache-client.
export const RENDER_KEY_ATTR = 'data-vmde-render-key'

/** "This block is about to be redrawn" — its stamp no longer describes what will be in it. Called
 *  from every redraw entry point in both families (findBlocks / resetCustomBlocks here, and the
 *  native re-render + offscreen-swap paths). Dropping the stamp alone is NOT enough to make the
 *  block reportable: an ASYNC engine (d2's WASM compile, mermaid/plantuml offscreen) leaves the old
 *  picture on screen while it works, so `put` also requires the markup to have actually changed
 *  before it files anything under the current key. */
export function clearRenderKey(el: Element | null | undefined): void {
  el?.removeAttribute(RENDER_KEY_ATTR)
}

// Shared reset step for every reRenderX (wavedrom, nomnoml, geojson, topojson, vega/vega-lite,
// stl) — task 400: these were 6 near-identical bodies (clear data-processed/error, blank
// innerHTML), the same "fixed it in 5 of 6 copies" risk engine-registry.ts exists to prevent for
// other per-engine lists. `lang` accepts an array for vega/vega-lite, which share ONE reset pass
// (renderVegaBlock always calls faithfulRender with the literal 'vega', so vega-lite blocks carry
// `data-vega-error` too, not `data-vega-lite-error` — pass that literal as `errorAttr`, not derived
// from `lang`). D2/PlantUML/Graphviz/mermaid are WASM/worker-backed and out of scope (task 400).
export function resetCustomBlocks(
  container: ParentNode,
  lang: string | string[],
  errorAttr?: string,
): void {
  const langs = Array.isArray(lang) ? lang : [lang]
  const sel = langs
    .flatMap((l) => [
      `code.language-${l}[data-processed]`,
      `div.language-${l}[data-processed]`,
    ])
    .join(', ')
  // Task 412 follow-up — deliberately NOT "find panes as descendants of `container`, then query
  // within each pane" (what an earlier version of this did): when `container` is a NARROWED
  // per-diagram scope (task 412's own blockScopeOf, used to viewport-gate a single diagram), its
  // `.vditor-preview` fallback is the element's own immediate PARENT, which does not itself carry a
  // preview-pane class — the real `.vditor-preview` ancestor sits further up, OUTSIDE `container`.
  // "Panes as descendants" then finds nothing and silently skips the reset. A combined `:is(pane)
  // el` selector is evaluated against each candidate's FULL ancestor chain (not just ancestors
  // inside `container`), so it still finds the target correctly in that case — same fix as
  // diagram-surfaces.ts's `renderedDiagramTargets`, applied here since this reset step doesn't need
  // the pane element itself, only the language target.
  const renderedSel = `:is(${PANE_SEL}) :is(${sel})`
  for (const el of Array.from(
    container.querySelectorAll<HTMLElement>(renderedSel),
  )) {
    el.removeAttribute('data-processed')
    if (errorAttr) el.removeAttribute(errorAttr)
    // About to be redrawn → its render-key stamp no longer describes what will be in it.
    el.removeAttribute(RENDER_KEY_ATTR)
    el.innerHTML = ''
  }
}

// Task 643: full Preview marks a heavy block that is far off screen with this attribute until it
// scrolls near, then removes it and dispatches the release event on `document` (detail.block). The
// sweep below must not render a pending block early, and the custom-diagram observer re-scans a
// released one. Defined here so `diagrams` and `editing` share one spelling without importing each other.
export const PREVIEW_PENDING_ATTR = 'data-vmde-preview-pending'
export const PREVIEW_BLOCK_RELEASED_EVENT = 'vmde-preview-block-released'

// Exported for unit testing the code→div swap (notably the hljs-strip — see diagram-dom.test.ts).
export function findBlocks(
  root: ParentNode,
  lang: string,
): { wrapper: HTMLElement; code: string }[] {
  const results: { wrapper: HTMLElement; code: string }[] = []
  // Search preview panes first (IR/WYSIWYG collapsed preview, full Preview overlay),
  // then fall back to the whole root — custom languages (wavedrom, nomnoml, geojson,
  // topojson) are unknown to Vditor and may appear as bare <code> blocks without a
  // preview pane wrapper.
  const sel = `code.language-${lang}:not([data-processed="true"]), div.language-${lang}:not([data-processed="true"])`
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
    (element) =>
      !isSectionHoistHidden(element) &&
      !element.closest(`[${PREVIEW_PENDING_ATTR}]`),
  )
  for (const el of candidates) {
    // Skip editable source blocks — render only in preview context
    if (el.closest('.vditor-ir__marker--pre, .vditor-wysiwyg__pre')) continue
    if (!el.getAttribute('data-code')) {
      el.setAttribute('data-code', el.textContent?.trim() ?? '')
    }
    const code = el.getAttribute('data-code') ?? el.textContent?.trim() ?? ''
    if (!code) continue
    // <code> can't hold block-level children (div/svg/canvas) — browsers refuse to
    // parse them as DOM inside inline elements. Swap to a <div> with the same class
    // so renderers can append real elements.
    let wrapper = el
    if (el.tagName === 'CODE') {
      const div = document.createElement('div')
      // Drop the `hljs` class: Vditor's processCodeRender highlights these unknown-language blocks as
      // code first (adds `.hljs` to the <code>), and copying it onto the diagram <div> made the
      // highlight.js theme paint the code-PANEL background behind the (often transparent) diagram svg
      // — the rendered diagram sat on a code box instead of the page (task 161 follow-up). The diagram
      // only needs its `language-X` class for the theming/centering CSS to match.
      div.className = el.className
        .replace(/\bhljs\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (el.getAttribute('data-code'))
        div.setAttribute('data-code', el.getAttribute('data-code')!)
      el.replaceWith(div)
      wrapper = div
    }
    // Same reason as in resetCustomBlocks: every caller of findBlocks is about to render into this
    // wrapper, so the stamp describing the OLD markup must not survive into the new one.
    wrapper.removeAttribute(RENDER_KEY_ATTR)
    results.push({ wrapper, code })
  }
  return results
}
