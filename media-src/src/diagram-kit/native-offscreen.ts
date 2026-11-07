// Off-screen render→swap for Vditor's NATIVE diagram engines (task 59 primitive, generalised for
// the task-184 render cache). Each engine renders its source into a hidden off-flow sandbox; the
// finished <svg> is then copied ATOMICALLY into the live node — the live DOM never collapses to the
// (short) source, so there's no scroll jump and no flash. Two callers:
//   - mermaid-retheme.ts (live dark↔light re-render), and
//   - render-cache-client.ts (Phase 3: re-render a native block on a cache MISS, since Vditor's
//     one-shot open pass already skipped a block we reserved and can't be re-fired).
//
// Only engines whose output is a REUSABLE static <svg> AND whose Vditor renderer sets
// `data-processed` on completion (our poll signal) are here: mermaid, abc, flowchart.
// NOT echarts/mindmap (canvas) and NOT markmap (live d3 instance, no data-processed, 3-way DOM
// split). graphviz is also EXCLUDED: reserving it makes its Viz.js engine run twice (the blocked
// live pass still calls Viz.instance(), then our offscreen pass calls it again) and the second
// Viz worker hangs → the offscreen render never produces an svg (empirically: e2e leaves raw DOT).
// See task 184.
import { abcRender } from 'vditor/src/ts/markdown/abcRender'
import { flowchartRender } from 'vditor/src/ts/markdown/flowchartRender'
import { mermaidRender } from 'vditor/src/ts/markdown/mermaidRender'
import { clearRenderKey } from './diagram-dom'
import { renderDiagramError } from './diagram-error'

/** Does an offscreen render temp hold something worth swapping into the live node? A finished `<svg>`
 *  OR a themed error box. A BROKEN source renders its error box (`.vmde-diagram-error`, not an
 *  `<svg>`) offscreen; before this covered the box, the swap dropped it with the sandbox and `live`
 *  kept its raw source text with data-processed="true" — so Vditor's own renderer (guarded by
 *  data-processed) never re-ran and no error box ever showed (task 360; broken diagram → raw text). */
export function hasRenderedOutput(temp: HTMLElement): boolean {
  return !!temp.querySelector('svg, .vmde-diagram-error')
}

/** Move a finished offscreen render from its sandbox temp into the live node.
 *
 *  Copies the CHILDREN (the picture) *and* `data-code` — the SOURCE the patched renderers stamp on the
 *  node they drew (see patchAbcRender in esbuild-shared.mjs), which they need again on a re-render
 *  because the rendered SVG clobbers textContent. innerHTML alone copies children only, so without the
 *  attribute the live node keeps the picture but loses the source, and the next theme flip
 *  (reRenderLang: innerHTML='' → re-render) finds neither data-code nor textContent, bails out, and the
 *  diagram is GONE for good. Only abc hits this today (mermaid re-themes from an explicit theme,
 *  flowchart has no mono re-render), but carrying the attribute keeps future engines correct too. */
export function adoptRender(temp: HTMLElement, live: HTMLElement): void {
  // The finished render replaces the old picture — drop the stamp describing the old one (task 436)
  // so reportRenders files THIS markup under the current theme key.
  clearRenderKey(live)
  live.innerHTML = temp.innerHTML
  const code = temp.getAttribute('data-code')
  if (code) live.setAttribute('data-code', code)
}

/** One offscreen render→swap job: render `source` and copy the finished SVG into `live`. */
export interface NativeJob {
  live: HTMLElement
  source: string
}

// lang → the Vditor renderer. All query `.language-<lang>` on the passed element, read the source
// from textContent, and set `data-processed="true"` on completion. Extra args are ignored by
// renderers that don't use them.
type NativeRenderer = (
  el: HTMLElement,
  cdn: string,
  theme: 'dark' | 'light',
) => void
const RENDERERS: Record<string, NativeRenderer> = {
  mermaid: (el, cdn, theme) => mermaidRender(el, cdn, theme),
  abc: (el, cdn) => abcRender(el, cdn),
  flowchart: (el, cdn) => flowchartRender(el, cdn),
}

/** The native langs whose renders the cache can reuse (reserve + paint + offscreen-miss). */
export const NATIVE_CACHE_LANGS = Object.keys(RENDERERS)

/** Poll cap for an offscreen native render (task 705): above the 30 s mermaid render timeout. */
const NATIVE_POLL_CAP_MS = 35_000
const MERMAID_TIMEOUT_MESSAGE =
  'Mermaid did not finish drawing this diagram within 30 seconds.'

/**
 * Render each job's `source` in a hidden off-body sandbox using `lang`'s engine, then copy each
 * finished <svg> into its live node. Fire-and-forget async; `onSwapped(job)` fires after a job's
 * SVG lands. The sandbox inherits the LIVE node's computed `color` so engines that bake the
 * foreground from `getComputedStyle` (abc, flowchart) or `currentColor` (graphviz) render in the
 * content theme even though the sandbox sits off-body (mermaid ignores it — it takes an explicit
 * theme). No-op for an unknown lang / empty jobs.
 */
export function renderNativeJobs(
  lang: string,
  allJobs: NativeJob[],
  cdn: string,
  theme: 'dark' | 'light',
  onSwapped?: (job: NativeJob) => void,
): void {
  const render = RENDERERS[lang]
  // Task 705 (F7): an empty mermaid source makes mermaidRender return early without data-processed, so
  // the poll below would run to its cap for nothing. Nothing to show for an empty block.
  const jobs =
    lang === 'mermaid' ? allJobs.filter((j) => j.source.trim() !== '') : allJobs
  if (!render || jobs.length === 0) return
  const sandbox = document.createElement('div')
  sandbox.setAttribute('aria-hidden', 'true')
  // Lute-invisible in the (unlikely) event a serialize races before the sandbox is removed.
  sandbox.setAttribute('data-render', '1')
  // Inherit the content-theme foreground from a live node (settled by miss/re-theme time) so the
  // getComputedStyle-based engines bake the right colour off-body.
  const fg = jobs[0]?.live ? getComputedStyle(jobs[0].live).color : ''
  sandbox.style.cssText = `position:absolute;left:-99999px;top:0;width:800px;visibility:hidden;pointer-events:none${
    fg ? `;color:${fg}` : ''
  }`
  const temps = jobs.map((j) => {
    const t = document.createElement('div')
    t.className = `language-${lang}`
    t.textContent = j.source
    sandbox.appendChild(t)
    return t
  })
  document.body.appendChild(sandbox)
  render(sandbox, cdn, theme)

  // The renderers are fire-and-forget async (addScript-gated); poll until every temp is done, then
  // swap each finished SVG into its live node and drop the sandbox. Normal renders exit immediately
  // via `done`; the frame cap is only a leak-guard for a render that never completes — generous so a
  // COLD engine load (graphviz's Viz.js WASM instance is the slowest, well over the old ~3s cap) has
  // time to finish. ~1200 frames ≈ 20 s at 60 fps, far under any caller's own timeout.
  // Task 705 (F6): a TIME cap (above the 30 s mermaid render timeout) instead of a frame count, so a
  // throttled background tab cannot stretch it. On expiry a mermaid temp with no output shows the
  // timeout error at the block (a cache-MISS block is reserved, data-processed="true", and would keep
  // raw source text forever); other languages keep the old behaviour.
  const started = performance.now()
  const swap = () => {
    const done = temps.every(
      (t) =>
        t.getAttribute('data-processed') === 'true' || !!t.querySelector('svg'),
    )
    const capped = performance.now() - started > NATIVE_POLL_CAP_MS
    if (done || capped) {
      jobs.forEach((j, i) => {
        if (hasRenderedOutput(temps[i])) {
          adoptRender(temps[i], j.live)
          onSwapped?.(j)
        } else if (capped && lang === 'mermaid') {
          clearRenderKey(j.live)
          renderDiagramError(j.live, 'mermaid', MERMAID_TIMEOUT_MESSAGE)
        }
      })
      sandbox.remove()
      return
    }
    requestAnimationFrame(swap)
  }
  requestAnimationFrame(swap)
}
