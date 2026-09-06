// Scroll-position preservation when toggling between an edit mode (IR / WYSIWYG)
// and the full Preview overlay.
//
// Vditor's preview toolbar button (toolbar/Preview.ts) shows `.vditor-preview`
// (a FRESH render → scrollTop 0) and hides the edit pane. The edit pane keeps its
// scrollTop (only display:none'd), so preview→edit already lands where you left it —
// but edit→preview jumps to the top. The user wants to stay in place BOTH ways.
//
// We reuse the anchored interpolation (heading-align.ts, task 48) but anchor on
// ALL top-level blocks, not just headings. Dense anchors keep the mapping tight even
// mid-block — a diagram whose rendered height differs between the panes still lands
// the same RELATIVE point, because the interpolation is fractional WITHIN that one
// block (heading-only anchoring interpolated linearly across the whole section, so a
// tall diagram between headings landed wrong — the reported bug).
//
// The two panes do NOT pair 1:1 by index (this module used to assume they did, and the
// assumption cost us the bug twice — see task 364). IR carries blocks Preview has no
// counterpart for: the trailing edit paragraph, injected wrappers, structural nodes —
// measured 126 vs 122 on the all-renderers fixture. So we pair the two block sequences
// by LONGEST COMMON SUBSEQUENCE over coarse per-block signatures (sigOf/pairBlocks) and
// anchor on the paired blocks; extras simply drop out, and a future IR-only node cannot
// silently disable the dense path. Falls back to headings only (LOUDLY — logToHost) and
// then to a proportional map.
//
// Two timing facts shape the implementation:
//  1. The pane we read FROM is display:none by the time a style MutationObserver
//     fires (the toolbar hides it in the same handler) → we can't measure it then.
//     So we SNAPSHOT each pane's anchor (block + heading tops + geometry) on its
//     scroll events WHILE IT IS VISIBLE, and use the last snapshot at toggle time.
//  2. The preview render is debounced (options.preview.delay) and diagrams grow
//     async afterwards → a single write under-scrolls. So edit→preview PINS the
//     target for a short window, recomputing each frame as the preview settles,
//     and bails the moment the user scrolls (never fight the user).
//
// SV split mode (task 187): the LIVE source↔preview sync belongs to
// split-scroll-sync.ts; what THIS module adds is positioning at the mode SWITCH.
// Entering sv rebuilds `.vditor-sv` (innerHTML) → the source pane landed at 0 while
// the right pane got pinned — misaligned halves. Now sv entry pins the SOURCE pane to
// the stored edit anchor instead (split-scroll-sync then cascades the right pane off
// our programmatic scroll events). Leaving sv keeps the existing preview-anchor path:
// the right pane tracked the source while in sv, so mapping from it restores the spot.

import {
  type ScrollGeom,
  alignByHeadings,
  proportionalScroll,
} from './heading-align'
import { findScroller } from '../chrome/toolbar-scroll-guard'
import { logToHost } from '../util/webview-log'

const EDIT_PIN_MS = 400
// Long enough to outlast async diagram rendering (mermaid/echarts/graphviz grow
// the preview well after the debounced first paint); we recompute every frame so
// the position self-corrects as it settles, and bail the instant the user scrolls.
const PREVIEW_PIN_MS = 2000

interface Anchor {
  // Tops of ALL top-level blocks, and of headings only — relative to the scroller
  // content (0 = top). Blocks are the primary anchors (dense → tight mapping);
  // headings are the sparse fallback. `blockSigs` pairs the two panes' block lists
  // (see sigOf/pairBlocks): they are NOT 1:1 by index.
  blockTops: number[]
  blockSigs: string[]
  headTops: number[]
  geom: ScrollGeom
}

let installed = false
// One-shot so a per-frame pin can't spam the Output channel.
let warnedSparse = false
let editAnchor: Anchor | null = null
let previewAnchor: Anchor | null = null
let pinning = false
let editModeRequest = 0

// Vditor exposes no public typings for its internals here.
type AnyV = any
function vd(): AnyV {
  return (window as { vditor?: AnyV }).vditor
}

// The active edit pane's editable root (`pre.vditor-reset`), or null in sv/preview.
function editReset(): HTMLElement | null {
  const v = vd()
  const mode = v?.getCurrentMode?.()
  if (!mode || mode === 'sv') return null
  return (v?.vditor?.[mode]?.element as HTMLElement | undefined) ?? null
}

function previewEl(): HTMLElement | null {
  return (vd()?.vditor?.preview?.element as HTMLElement | undefined) ?? null
}

function previewReset(): HTMLElement | null {
  return (
    (vd()?.vditor?.preview?.previewElement as HTMLElement | undefined) ?? null
  )
}

// The element that actually SCROLLS the preview. NOT `vditor.preview.element`
// (`.vditor-preview`): in the real VS Code webview that wrapper is `overflow:hidden` and the inner
// `.vditor-reset` is the scroll container (`overflow:auto`); in the test harness it's the wrapper.
// `findScroller` resolves whichever it is (walk up from the reset to the first scrollable ancestor,
// returning the reset itself when IT scrolls). Using the wrong element silently no-ops scrollTop.
function previewScroller(): HTMLElement | null {
  const reset = previewReset()
  return reset ? findScroller(reset) : null
}

function blockChildren(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return Array.from(root.children) as HTMLElement[]
}

// sv source blocks carry no <h1>..<h6> — a heading there is a block whose text starts
// with `#…␠` (same detection split-scroll-sync uses). Rendered panes use the tag.
const SV_HEADING_RE = /^#{1,6}\s/
function headingChildren(root: HTMLElement | null): HTMLElement[] {
  if (root?.classList.contains('vditor-sv')) {
    return blockChildren(root).filter((el) =>
      SV_HEADING_RE.test((el.textContent ?? '').trimStart()),
    )
  }
  return blockChildren(root).filter((el) => /^H[1-6]$/.test(el.tagName))
}

// The sv split's SOURCE pane (`.vditor-sv`) — it is its own scroll container.
function svSourceEl(): HTMLElement | null {
  return (vd()?.vditor?.sv?.element as HTMLElement | undefined) ?? null
}

// Top of `el` relative to `container`'s content (0 = top of content).
function topWithin(container: HTMLElement, el: HTMLElement): number {
  return (
    el.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop
  )
}

function geomOf(el: HTMLElement): ScrollGeom {
  return {
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }
}

function topsOf(scroller: HTMLElement, els: HTMLElement[]): number[] {
  return els.map((el) => topWithin(scroller, el))
}

// A coarse, PANE-INDEPENDENT identity for a top-level block. The two panes render the same markdown
// but NOT into the same DOM: a fenced block is `div.vditor-ir__node[data-type=code-block]` in IR and
// `<pre>` (plain code) or `div.language-X` (a diagram, findBlocks rewrites code→div) in Preview; IR
// also carries its source markers inside the block, so textContent differs too. What DOES survive
// both is the block's KIND (and, for a heading, its text) — enough to align the two sequences.
function sigOf(el: HTMLElement): string {
  const tag = el.tagName
  if (/^H[1-6]$/.test(tag))
    return `h:${(el.textContent ?? '').replace(/[#\s]/g, '').slice(0, 24)}`
  const langHost = (el.getAttribute('class') ?? '').includes('language-')
    ? el
    : el.querySelector('[class*="language-"]')
  const lang = (langHost?.getAttribute('class') ?? '').match(
    /language-([\w-]+)/,
  )?.[1]
  if (lang) return `lang:${lang}`
  if (
    el.getAttribute('data-type') === 'math-block' ||
    el.querySelector('.katex-display')
  )
    return 'math'
  if (tag === 'HR') return 'hr'
  if (tag === 'TABLE') return 'table'
  if (tag === 'BLOCKQUOTE') return 'bq'
  if (tag === 'UL' || tag === 'OL') return 'list'
  return 'p'
}

// Longest-common-subsequence pairing of two block-signature sequences → the indices that correspond.
// WHY not index-by-index (what this module used to do): IR carries blocks Preview has no counterpart
// for — the trailing edit paragraph, injected wrappers, structural nodes — so the counts differ (126
// vs 122 on the all-renderers fixture) and a strict 1:1 check silently rejected the dense anchors and
// fell back to the ~22 sparse HEADING anchors. That sparse path interpolates linearly across a whole
// section, so a tall diagram inside one lands far off — the exact "screen jumps on switch, worse with
// a big diagram" report. Pairing by subsequence keeps the dense anchors and simply drops the extras,
// and it stays correct when the next IR-only node is added.
// Both sequences describe the same document in the same order, so the LCS is a monotonic alignment.
const lcsCache = new Map<string, [number[], number[]]>()
function pairBlocks(a: string[], b: string[]): [number[], number[]] {
  const key = `${a.join('')} ${b.join('')}`
  const hit = lcsCache.get(key)
  if (hit) return hit
  const n = a.length
  const m = b.length
  // (n+1)×(m+1) DP over a flat array; ~130×130 here, and computed once per distinct pane pair.
  const dp = new Uint16Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        a[i] === b[j]
          ? dp[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1])
    }
  }
  const ia: number[] = []
  const ib: number[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ia.push(i)
      ib.push(j)
      i++
      j++
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) i++
    else j++
  }
  const pair: [number[], number[]] = [ia, ib]
  // Bounded: one entry per distinct document shape seen in this webview.
  if (lcsCache.size > 8) lcsCache.clear()
  lcsCache.set(key, pair)
  return pair
}

function snapshot(scroller: HTMLElement, root: HTMLElement): Anchor {
  const blocks = blockChildren(root)
  return {
    blockTops: topsOf(scroller, blocks),
    blockSigs: blocks.map(sigOf),
    headTops: topsOf(scroller, headingChildren(root)),
    geom: geomOf(scroller),
  }
}

// Map a stored FROM anchor onto the live TO pane. Try ALL blocks first (dense,
// 1:1 → tight even mid-block: a diagram whose rendered height differs between the
// panes still lands the same relative point, because the fractional interpolation
// is WITHIN that one block); fall back to headings only (sparser, survives a block-
// count drift), then to a proportional map. Returns null if the TO pane is unusable.
function targetFor(
  from: Anchor | null,
  toScroller: HTMLElement | null,
  toRoot: HTMLElement | null,
): number | null {
  if (!from || !toScroller || !toRoot) return null
  const toGeom = geomOf(toScroller)
  // Dense path: pair the two panes' block sequences, then anchor on the PAIRED blocks only.
  const toBlocks = blockChildren(toRoot)
  const [ia, ib] = pairBlocks(from.blockSigs, toBlocks.map(sigOf))
  // Require a real correspondence, not a couple of accidental matches, before trusting it.
  if (
    ia.length >= 2 &&
    ia.length >= Math.min(from.blockSigs.length, toBlocks.length) * 0.5
  ) {
    const byBlock = alignByHeadings(
      from.geom,
      ia.map((i) => from.blockTops[i]),
      toGeom,
      ib.map((i) => topWithin(toScroller, toBlocks[i])),
    )
    if (byBlock !== null) return byBlock
  } else if (!warnedSparse) {
    // LOUD: falling back to the sparse heading anchors is what makes a tall diagram land far off.
    // If this ever fires, block pairing broke — surface it instead of silently degrading.
    warnedSparse = true
    logToHost(
      `preview-scroll-preserve: block anchors did not pair (from=${from.blockSigs.length} to=${toBlocks.length} paired=${ia.length}) — falling back to sparse heading anchors; mode-switch scroll will drift`,
    )
  }
  const byHead = alignByHeadings(
    from.geom,
    from.headTops,
    toGeom,
    topsOf(toScroller, headingChildren(toRoot)),
  )
  if (byHead !== null) return byHead
  return proportionalScroll(from.geom, toGeom)
}

// Hold `scroller` at the computed target for `ms`, recomputing each frame as the
// content settles (debounced preview render + async diagrams). Bails on the first
// genuine user scroll (wheel / touch / key) so we never fight the user.
// `getScroller` is resolved LAZILY each frame: when entering Preview the scroll container may not
// exist/be scrollable yet (the render is debounced + diagrams grow async, and findScroller can't
// pick the real overflow:auto element until it overflows) — so we re-resolve until it's ready.
function pin(
  getScroller: () => HTMLElement | null,
  compute: () => number | null,
  ms: number,
  isActive: () => boolean = () => true,
) {
  pinning = true
  let bailed = false
  let lastWritten = Number.NaN
  // Content height at our last write. The pin runs WHILE the preview is still growing (debounced
  // render + async diagrams), and growth above the viewport shifts scrollTop on its own — which is
  // NOT the user scrolling. See the guard below.
  let lastHeight = -1
  const bail = () => {
    bailed = true
  }
  // User input → release (never fight the user). A 'scroll' whose position isn't the value WE just
  // wrote means the user moved it (incl. a scrollbar drag, which fires no wheel/key). Listen on
  // document (capture) since the scroller element isn't known up front / can change.
  //
  // BUT only when the content height is UNCHANGED. Otherwise this guard misfires on the preview's own
  // growth: diagrams render async and the scroller grows (measured 12028 → 16686px within ~1s on the
  // all-renderers fixture), the browser shifts scrollTop to keep the anchored content in view, we see
  // scrollTop != lastWritten and bail — abandoning the pin at whatever half-rendered target we had
  // computed. That is what left the reader 750px off at 75% scroll even with correct dense anchors
  // (task 364): the anchors were right, the pin just stopped applying them. Genuine input still bails
  // instantly through the wheel/touch/keydown handlers above.
  const onScroll = () => {
    const sc = getScroller()
    if (!sc || Number.isNaN(lastWritten)) return
    if (sc.scrollHeight !== lastHeight) return // our own content still settling
    if (Math.abs(sc.scrollTop - lastWritten) > 2) bailed = true
  }
  document.addEventListener('wheel', bail, { passive: true, capture: true })
  document.addEventListener('touchmove', bail, { passive: true, capture: true })
  document.addEventListener('keydown', bail, true)
  document.addEventListener('scroll', onScroll, {
    passive: true,
    capture: true,
  })
  const cleanup = () => {
    pinning = false
    document.removeEventListener('wheel', bail, { capture: true } as never)
    document.removeEventListener('touchmove', bail, { capture: true } as never)
    document.removeEventListener('keydown', bail, true)
    document.removeEventListener('scroll', onScroll, { capture: true } as never)
  }
  // Frame budget instead of wall-clock (no Date.now needed; ~60fps → ms/16 frames).
  // We recompute every frame so the target tracks the preview growing as its async
  // diagrams render; holding the same value once settled is a harmless no-op.
  let frames = Math.max(1, Math.round(ms / 16))
  const tick = () => {
    if (bailed || !isActive()) {
      cleanup()
      return
    }
    const scroller = getScroller()
    const t = scroller ? compute() : null
    if (scroller && t !== null) {
      scroller.scrollTop = t
      lastWritten = scroller.scrollTop
      lastHeight = scroller.scrollHeight
    }
    if (--frames > 0) requestAnimationFrame(tick)
    else cleanup()
  }
  requestAnimationFrame(tick)
}

// Snapshot whichever pane is currently visible+scrolling, so the value is fresh
// at the next toggle. Skipped while we're pinning (our own writes aren't input).
function captureVisibleAnchor() {
  if (pinning) return
  const pv = previewEl()
  if (pv && pv.style.display === 'block') {
    const reset = previewReset()
    const scroller = previewScroller()
    if (reset && scroller) previewAnchor = snapshot(scroller, reset)
    return
  }
  const edit = editReset()
  if (edit) editAnchor = snapshot(findScroller(edit), edit)
}

function onEnterPreview() {
  // sv entry (task 187): pin the SOURCE pane to the edit anchor — the pane is rebuilt
  // on every switch and landed at 0. Our programmatic scrollTop writes fire scroll
  // events, so split-scroll-sync cascades the right pane; pinning that one too would
  // put two writers on it. sv anchors: blocks = data-block divs (1:1 with the edit
  // pane's Lute blocks), headings = `#…␠` text blocks (headingChildren handles both).
  if (vd()?.getCurrentMode?.() === 'sv') {
    const sv = svSourceEl()
    if (!sv) return
    pin(
      () => findScroller(sv),
      () => targetFor(editAnchor, findScroller(sv), sv),
      EDIT_PIN_MS,
    )
    return
  }
  // Pin the preview to the edit position while its (debounced + diagram-async) render settles;
  // re-resolve the scroller + recompute the target live each frame from the stored edit anchor.
  pin(
    previewScroller,
    () => targetFor(editAnchor, previewScroller(), previewReset()),
    PREVIEW_PIN_MS,
  )
}

function onLeavePreview() {
  const edit = editReset()
  if (!edit) return
  // The edit pane is already laid out (just un-hidden); a short pin absorbs any
  // re-layout settle. Map from the last preview anchor.
  pin(
    () => findScroller(edit),
    () => targetFor(previewAnchor, findScroller(edit), edit),
    EDIT_PIN_MS,
  )
}

/** Vditor rebuilds the target edit DOM for an IR↔WYSIWYG selection, so map the saved visible
 *  edit block onto that fresh surface exactly as we do for Preview and split entry. Its own mode
 *  button handler stops propagation, which means toolbar-scroll-guard's bubble restore cannot see
 *  this interaction. */
function onEnterEditMode(
  anchor: Anchor,
  targetMode: 'ir' | 'wysiwyg',
  request: number,
) {
  if (
    request !== editModeRequest ||
    vd()?.getCurrentMode?.() !== targetMode ||
    previewEl()?.style.display === 'block'
  )
    return
  const edit = editReset()
  if (!edit) return
  // `pin()` deliberately starts on rAF for settling renders. Write the mapped destination now as
  // well: this callback already runs in the first post-Vditor layout frame, so waiting for pin's
  // next frame would paint a one-frame jump to the document start.
  const initialScroller = findScroller(edit)
  const initialTarget = targetFor(anchor, initialScroller, edit)
  if (initialTarget !== null) initialScroller.scrollTop = initialTarget
  const active = () =>
    request === editModeRequest &&
    vd()?.getCurrentMode?.() === targetMode &&
    previewEl()?.style.display !== 'block'
  const activeEdit = () => (active() ? editReset() : null)
  pin(
    () => {
      const current = activeEdit()
      return current ? findScroller(current) : null
    },
    () => {
      const current = activeEdit()
      return current ? targetFor(anchor, findScroller(current), current) : null
    },
    EDIT_PIN_MS,
    active,
  )
}

export function setupPreviewScrollPreserve() {
  if (installed) return
  installed = true

  // Snapshot the visible pane on scroll (capture: scroll doesn't bubble), rAF-
  // debounced so it costs ~one measure per frame regardless of scroll rate.
  let queued = false
  document.addEventListener(
    'scroll',
    () => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        captureVisibleAnchor()
      })
    },
    true,
  )

  // Capture while the outgoing edit surface is still visible. Vditor's target handler rebuilds
  // the destination synchronously and stops bubbling, so defer the pin one frame from capture
  // rather than relying on toolbar-scroll-guard's bubble-phase click listener.
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest<HTMLButtonElement>(
        '.vditor-toolbar [data-mode]',
      )
      if (!button) return
      const requested = button.dataset.mode
      const request = ++editModeRequest
      if (requested !== 'ir' && requested !== 'wysiwyg') return
      const v = vd()
      if (
        v?.getCurrentMode?.() === requested ||
        (v?.getCurrentMode?.() !== 'ir' &&
          v?.getCurrentMode?.() !== 'wysiwyg') ||
        previewEl()?.style.display === 'block'
      )
        return
      const source = editReset()
      if (!source) return
      const anchor = snapshot(findScroller(source), source)
      // Capture is local and synchronous; defer the destination lookup through a microtask and
      // one layout frame so Vditor's synchronous handler has created the new edit surface before
      // `findScroller` measures it. The request token makes a later mode choice cancel this work.
      queueMicrotask(() =>
        requestAnimationFrame(() =>
          onEnterEditMode(anchor, requested, request),
        ),
      )
    },
    true,
  )

  // React to the preview overlay being shown/hidden, however it was triggered.
  const wire = (pv: HTMLElement) => {
    let prev = pv.style.display
    new MutationObserver(() => {
      const now = pv.style.display
      if (now === prev) return
      const wasBlock = prev === 'block'
      prev = now
      if (now === 'block' && !wasBlock) onEnterPreview()
      else if (now !== 'block' && wasBlock) onLeavePreview()
    }).observe(pv, { attributes: true, attributeFilter: ['style'] })
  }

  const pv = previewEl()
  if (pv) {
    wire(pv)
  } else {
    // Preview element not built yet — wait for it (defensive; it normally exists
    // by the time runFinishInit runs).
    const poll = () => {
      const el = previewEl()
      if (el) wire(el)
      else requestAnimationFrame(poll)
    }
    requestAnimationFrame(poll)
  }
}
