// ECharts charts + mindmaps are sized to the container width ONCE at init and echarts installs no
// resize handler, so they don't track later width changes — the editor's reading column settling
// AFTER init (instant-paint→live swap / iframe layout / scrollbar), or a window/pane resize. Two
// symptoms: "czasami pierwszy render za szeroki" (the column settled narrower than the init width)
// and charts not shrinking with the window.
//
// CRITICAL — we do NOT use `instance.resize()`. The chart Vditor renders has an ORPHANED instance:
// `getInstanceByDom(el)` returns null (Vditor re-creates the preview element after init, leaving a
// dead `_echarts_instance_` attr), so `resize()` is a silent no-op — which is why the previous
// window-resize + deferred-timer (`[150,450,1000,2000]`) approach never actually resized anything.
// Instead we RECONSTRUCT from the source JSON at the current container width (reconstructCharts /
// reconstructMindmaps in echarts-retheme.ts) — proven in the real editor to fix a stuck canvas.
//
// Trigger = a ResizeObserver on each chart/mindmap container (the only thing that fires exactly when
// the reading column settles — a width change is a LAYOUT change, not a DOM mutation, so the old
// timers guessed and a MutationObserver can't see it). rAF-coalesced. The reconstruct* are dedupe-
// guarded (skip when the canvas already fits its container, skip hidden 0-width), so a mode switch
// (width unchanged / pane hidden) does NOT reconstruct → no "tekst w tle" flicker (the trap that
// killed the earlier ResizeObserver-that-called-resize()). A window 'resize' listener (trailing
// debounce) is kept as a belt-and-suspenders path (also dedupe-guarded, so it's a no-op when nothing
// changed). mindmap INITIAL render is still handled by observeMindmaps (a MutationObserver — it fires
// on the DOM mutation when Vditor first draws the canvas).

import { coalescePerFrame } from '../util/observe-coalesce'
import { debounce } from '../util/debounce'
import { reconstructCharts, reconstructMindmaps } from './echarts-retheme'
import {
  forEachChangeScope,
  forEachRecordScope,
  liveFeedOf,
  onLiveChange,
} from '../util/mutation-impact'

type EchartsGlobal = { getInstanceByDom?: (el: Element) => unknown }

const TRAILING_MS = 120

let installed = false

export function installEchartsResize(
  win: Window & {
    echarts?: EchartsGlobal
    __vmdeEchartsResolve?: (ec: unknown) => string | undefined
    // ResizeObserver/MutationObserver are global constructors (lib.dom `declare var`) but not members of
    // the `Window` interface, so accessing them as win.* needs declaring. ResizeObserver is optional —
    // guarded at runtime for older webviews; MutationObserver is always present.
    ResizeObserver?: typeof ResizeObserver
    MutationObserver: typeof MutationObserver
  },
): () => void {
  // Already wired for this window — re-installing would double the resize
  // listeners, so hand back a no-op disposer for the redundant call.
  if (installed)
    return () => {
      /* no-op disposer */
    }
  installed = true

  // Re-fit every chart + mindmap to its container by reconstructing from source. Both reconstruct*
  // skip elements whose canvas already fits (dedupe) and hidden 0-width containers, so calling this
  // redundantly (window resize AND ResizeObserver) is cheap.
  const fit = () => {
    const ec = win.echarts
    if (!ec) return
    reconstructCharts(win, win.document)
    reconstructMindmaps(win, win.document, win.__vmdeEchartsResolve?.(ec))
  }

  // Window resize — trailing debounce (settled width, not an intermediate one mid-drag). debounce()
  // is setTimeout-based, not rAF, and that is load-bearing here: rAF is paused when the webview is
  // backgrounded, a timer still fires. Its timer comes from the module's own realm rather than
  // `win` — in the webview those are the same window, and `fit` reads `win.document` either way.
  const fitSettled = debounce(fit, TRAILING_MS)
  win.addEventListener('resize', fitSettled)

  // ResizeObserver on the diagram containers → catches the first-render column settle (and pane
  // resizes) exactly when the width changes. rAF-coalesced so a burst of container resizes fits once.
  let raf = 0
  let ro: ResizeObserver | undefined
  let mo: MutationObserver | undefined
  let reobserve: ReturnType<typeof coalescePerFrame> | undefined
  let scopeFrame = 0
  let offFeed: (() => void) | undefined
  if (typeof win.ResizeObserver === 'function') {
    const onResize = () => {
      if (!raf)
        raf = win.requestAnimationFrame(() => {
          raf = 0
          fit()
        })
    }
    ro = new win.ResizeObserver(onResize)
    const SEL =
      '.vditor-ir__preview .language-echarts, .vditor-wysiwyg__preview .language-echarts, .vditor-ir__preview .language-mindmap, .vditor-wysiwyg__preview .language-mindmap'
    // (Re)observe diagram containers as Vditor (re)builds them. ResizeObserver.observe is idempotent
    // for an already-observed element, so re-scanning is safe — coalesced per frame (185/2c) so a
    // keystroke's mutation burst pays one querySelectorAll sweep, not one per checkpoint.
    const sweep = () => {
      for (const el of Array.from(
        win.document.querySelectorAll<HTMLElement>(SEL),
      ))
        ro?.observe(el)
    }
    reobserve = coalescePerFrame(sweep)
    const app = win.document.getElementById('app') || win.document.body
    // Task 733 (012-13, D-13 binding rules 2 and 6): while the unit feed is live, records inside its
    // root are left to the feed. The containers are looked up inside the change scopes and inside
    // the render subtrees the feed never reports (`forEachRecordScope`), in the next frame; the
    // document sweep stays for a whole change and for every record without a live feed.
    const scopes = new Set<Element>()
    const observeScopes = () => {
      scopeFrame = 0
      for (const scope of scopes) {
        if (!scope.isConnected) continue
        if (scope.matches(SEL)) ro?.observe(scope)
        for (const el of Array.from(scope.querySelectorAll<HTMLElement>(SEL)))
          ro?.observe(el)
      }
      scopes.clear()
    }
    const addScope = (scope: Element) => {
      scopes.add(scope)
    }
    const scheduleScopes = () => {
      if (scopes.size > 0 && !scopeFrame)
        scopeFrame = win.requestAnimationFrame(observeScopes)
    }
    mo = new win.MutationObserver((records) => {
      if (!liveFeedOf(app)) {
        reobserve?.()
        return
      }
      forEachRecordScope(app, records, addScope)
      scheduleScopes()
    })
    mo.observe(app, {
      childList: true,
      subtree: true,
    })
    offFeed = onLiveChange(app, (change) => {
      if (change.whole) {
        reobserve?.()
        return
      }
      forEachChangeScope(change, addScope)
      scheduleScopes()
    })
    reobserve()
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    win.removeEventListener('resize', fitSettled)
    fitSettled.cancel()
    ro?.disconnect()
    mo?.disconnect()
    reobserve?.cancel()
    offFeed?.()
    if (scopeFrame) win.cancelAnimationFrame(scopeFrame)
    if (raf) win.cancelAnimationFrame(raf)
    installed = false
  }
}
