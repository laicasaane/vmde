// Task 229 — clickable code references (`src/foo.ts:42[:col]`) in prose and inline code.
//
// DO NOT reach for `data-render="1"` here on reflex (the house rule for Lute-invisible injected
// DOM — see the `ghost-span-not-lute-transparent` precedent, e.g. diagram-error/-loading/-note,
// edit-activity's keep-last overlay, render-cache-client, mutation-scope.ts's own doc). That rule
// is for injected content with NO markdown counterpart — Lute's IR/WYSIWYG walkers do
// `if (d==="1"||d==="2") return`, SKIPPING THE WHOLE SUBTREE, which is exactly right when the
// injected node is pure UI (a callout preview, a diagram error box) and exactly WRONG here: a
// code-ref chip's text **is** the document's real markdown content, so skipping its subtree
// would delete the reference from the saved file on the next `getValue()`. Measured, not assumed
// (`tmp/229-code-ref-spike/`, a Lute-in-Node harness — shim window/self=globalThis + require the
// vendored lute.min.js, no browser/webview needed for a fast serialization-fidelity check): a plain
// `<span class="vmde-code-ref-chip">` with no `data-render`/`data-type` is ALREADY transparent
// to Lute's `VditorIRDOM2Md`/`SpinVditorIRDOM` — both walk straight through an unrecognised inline
// span to its text, round-tripping byte-identical with no strip/reintroduce step (spike2.mjs #6).
// This is also why we need none of wiki-serialize.ts's chip↔source rewrite dance: a wiki chip's
// DISPLAY text can differ from its `[[target|label]]` SOURCE syntax, so Lute's default "walk
// through to the text" behaviour would serialize the wrong string — ours never differs (the
// chip's text IS the source), so the default behaviour is already correct. Rule of thumb for the
// next inline-DOM-injection feature: `data-render` if the node has no markdown counterpart to
// preserve; a bare class-only span if it wraps real content that must survive `getValue()`.
//
// Two decoration shapes, per the task's explicit design constraint:
//  - PROSE text: wrap the matched substring in a `<span class="vmde-code-ref-chip">` (see above
//    for why it's bare, not `data-render`).
//  - INLINE CODE (`` `src/foo.ts:42` ``): attribute/class only on the existing `<code>` element —
//    "no DOM injection inside `<code>`" (task 229). Verified clean round-trip too (spike.mjs #2).
//    Only decorates when the code span's ENTIRE text is one ref (`matchWholeCodeRef`); a `<code>`
//    with other content around a ref is left alone rather than partially decorated.
//
// Resolution ("unresolved paths stay plain — no dead-link chips") is async (a host round-trip,
// code-ref-resolve.ts) but Lute rendering is synchronous, so this can't be done as a Lute custom
// renderer at parse time (unlike wiki links, which have a synchronous `knownPages` set). Instead:
// a MutationObserver-driven post-process, same family as callouts.ts/code-source.ts — block-scoped
// via mutation-scope.ts, coalesced per frame, and skipping the block that currently holds the
// caret (typing INSIDE a ref would otherwise have every keystroke tear down and rebuild the span
// around the live selection — Vditor's own caret restore only knows about its `<wbr>` marker, not
// ours). `selectionchange` triggers a full re-walk so the block just left gets decorated promptly,
// and a host reply re-walks too (registerCodeRefReapply) so a newly-resolved path anywhere in the
// document gets chipped without waiting for an unrelated edit.

import {
  findCodeRefs,
  matchWholeCodeRef,
} from '../../../src/shared/code-ref-core'
import type { CodeRefMatch } from '../../../src/shared/code-ref-core'
import type { WebviewMessage } from '../../../src/shared/protocol'
import { coalescePerFrameWithRecords } from '../util/observe-coalesce'
import { queryIncludingSelf, scopeMutations } from '../util/mutation-impact'
import {
  codeRefResolution,
  registerCodeRefReapply,
  requestCodeRefResolution,
} from './code-ref-resolve'

// Task 457 measured that Tab can never reach an in-document chip regardless of tabindex (Vditor's
// `tab: '\t'` preventDefaults every Tab in the editable surface) and replaced wiki chips' focus
// model with caret-targeted Activate Link at Caret (see caret-link.ts) instead of removing this.
// Code-ref chips are IN `LINK_LIKE_SELECTOR` (caret-link.ts), so that command activates them from the
// caret — this tabindex is now redundant with that, not load-bearing, and left in place only
// because 457's scope was drawn at wiki chips; folding code-ref chips onto the same caret-only
// model (dropping this + `[data-code-ref="1"]`'s own Enter/Space-on-focus path in link-click-fix.ts)
// is unclaimed follow-up, not done here.
const CHIP_TABINDEX = '0'

const CHIP_CLASS = 'vmde-code-ref-chip'
const INLINE_CODE_CLASS = 'vmde-code-ref'

// Subtrees a code reference must never be recognised inside: fenced/inline code (handled by its
// OWN pass below, never the prose-text one), Vditor's IR marker/preview scaffolding, math, an
// existing link (never stack a second affordance on top of one), and our own already-decorated
// chips (re-entering one would re-match its own display text).
//
// `pre:not(.vditor-reset)`, NOT bare `pre` (measured, real-VS-Code e2e red-then-green — a bare
// `pre` silently excluded the ENTIRE editable surface, not just fenced code blocks): Vditor's IR
// AND WYSIWYG editor ROOT is itself `<pre class="vditor-reset">` (`ir/index.ts` / `wysiwyg/
// index.ts`, both `divElement.innerHTML = '<pre class="vditor-reset" ...'`), the same technique
// html-builder.ts's prerender teaser copies (`<pre class="vditor-reset">${preRenderedHtml}</pre>`)
// — so a bare `pre` in this selector rejected that root's WHOLE subtree, meaning NOTHING inside
// the actual document ever got walked (only chrome outside it, e.g. the toolbar, did) while unit
// tests (a plain `<div>` root) never exercised this path. A genuine fenced code block's `<pre>`
// (IR's `pre.vditor-ir__marker--pre`/`pre.vditor-ir__preview`, WYSIWYG's `pre.vditor-wysiwyg__pre`,
// Preview's plain Lute-rendered `<pre>`) never carries `.vditor-reset`, so this still excludes them.
const SKIP_SELECTOR =
  'pre:not(.vditor-reset), code, .vditor-ir__marker, .vditor-ir__preview, a[href], [data-wiki-link], [data-code-ref], [data-type="math-block"], [data-type="math-inline"]'

function isSkippedElement(el: Element): boolean {
  return el.matches(SKIP_SELECTOR)
}

/** True for a genuine fenced code-BLOCK's `<code>` (IR's `pre.vditor-ir__marker--pre`, WYSIWYG's
 *  `pre.vditor-wysiwyg__pre`, Preview's plain Lute `<pre>`) — false for inline code. Same
 *  `:not(.vditor-reset)` reasoning as SKIP_SELECTOR above: `code.closest('pre')` alone would ALSO
 *  match every INLINE code's own ancestor editor root (`<pre class="vditor-reset">`), wrongly
 *  treating it as a block and skipping it entirely (measured, real-VS-Code e2e red-then-green —
 *  every inline ref silently never decorated). */
function isInFencedCodeBlock(code: Element): boolean {
  return !!code.closest('pre:not(.vditor-reset)')
}

/** Every text node under `root` that isn't inside a skipped subtree, via a properly PRUNING
 *  TreeWalker (an element match returns FILTER_REJECT, so the walker never even descends into a
 *  `<pre>`/`<code>`/etc — cheaper than a post-hoc `closest()` check per text node on a large doc). */
function collectDecoratableTextNodes(root: Element): Text[] {
  const nodes: Text[] = []
  const doc = root.ownerDocument ?? document
  const walker = doc.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          return isSkippedElement(node as Element)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP // visit children, don't collect the element itself
        }
        return NodeFilter.FILTER_ACCEPT
      },
    },
  )
  let n = walker.nextNode()
  while (n) {
    nodes.push(n as Text)
    n = walker.nextNode()
  }
  return nodes
}

function chipTitle(m: CodeRefMatch): string {
  return `Ctrl+click to open ${m.path}:${m.line}${m.col !== undefined ? `:${m.col}` : ''}`
}

/** Wrap every RESOLVED match in `textNode` with a chip span, right-to-left so earlier matches'
 *  offsets stay valid across the splits (each `splitText` only affects what comes after it).
 *  Unresolved matches are left as plain text and queued for a host existence check. */
function decorateTextNode(
  textNode: Text,
  post: (msg: WebviewMessage) => void,
): void {
  const matches = findCodeRefs(textNode.data)
  if (matches.length === 0) return
  const doc = textNode.ownerDocument ?? document
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const resolved = codeRefResolution(m.path)
    if (resolved === undefined) {
      requestCodeRefResolution(m.path, post)
      continue // not yet known — leave plain; the resolution reply triggers a full re-walk
    }
    if (resolved === false) continue // confirmed non-existent — stays plain, never re-asked
    const tail = textNode.splitText(m.index)
    tail.splitText(m.source.length) // the trailing remainder stays a plain sibling text node
    const span = doc.createElement('span')
    span.className = CHIP_CLASS
    span.setAttribute('tabindex', CHIP_TABINDEX)
    span.setAttribute('data-code-ref', '1')
    span.setAttribute('data-code-ref-path', m.path)
    span.setAttribute('data-code-ref-line', String(m.line))
    if (m.col !== undefined)
      span.setAttribute('data-code-ref-col', String(m.col))
    span.title = chipTitle(m)
    span.textContent = tail.data
    tail.replaceWith(span)
  }
}

/** Attribute-only decoration for an inline `<code>` whose ENTIRE text is one code reference —
 *  never touches its children (task 229: "no DOM injection inside `<code>`"). Idempotent: a
 *  `<code>` this doesn't apply to (already decorated the same way, or genuinely not a whole ref)
 *  is left untouched, matching code-source.ts's tagSources style. */
function decorateInlineCode(
  code: HTMLElement,
  post: (msg: WebviewMessage) => void,
): void {
  const m = matchWholeCodeRef(code.textContent ?? '')
  if (!m) {
    if (code.hasAttribute('data-code-ref')) undecorateInlineCode(code)
    return
  }
  const resolved = codeRefResolution(m.path)
  if (resolved === undefined) {
    requestCodeRefResolution(m.path, post)
    return
  }
  if (resolved === false) {
    if (code.hasAttribute('data-code-ref')) undecorateInlineCode(code)
    return
  }
  if (code.getAttribute('data-code-ref-source') === m.source) return // already decorated, unchanged
  code.classList.add(INLINE_CODE_CLASS)
  code.setAttribute('data-code-ref', '1')
  code.setAttribute('data-code-ref-source', m.source)
  code.setAttribute('data-code-ref-path', m.path)
  code.setAttribute('data-code-ref-line', String(m.line))
  if (m.col !== undefined) code.setAttribute('data-code-ref-col', String(m.col))
  else code.removeAttribute('data-code-ref-col')
  code.title = chipTitle(m)
  code.setAttribute('tabindex', CHIP_TABINDEX)
}

function undecorateInlineCode(code: HTMLElement): void {
  code.classList.remove(INLINE_CODE_CLASS)
  for (const attr of [
    'data-code-ref',
    'data-code-ref-source',
    'data-code-ref-path',
    'data-code-ref-line',
    'data-code-ref-col',
    'tabindex',
  ])
    code.removeAttribute(attr)
  code.removeAttribute('title')
}

/** True when the live selection's anchor sits inside `el` — used to skip decorating the block
 *  currently being typed in (see module doc: typing inside a ref would otherwise have every
 *  keystroke tear down and rebuild the span around the live caret). */
function hasLiveCaret(el: Element): boolean {
  const sel = (el.ownerDocument ?? document).getSelection?.()
  const anchor = sel?.rangeCount ? sel.anchorNode : null
  return !!anchor && el.contains(anchor)
}

/** The top-level `[data-block]` element the live selection's anchor sits in, or null. Vditor
 *  stamps `data-block` on IR/WYSIWYG's top-level elements only (not the read-only Preview
 *  render, which has no caret to protect anyway — the lookup simply finds nothing there,
 *  decorating everything). */
function caretBlockOf(root: Element): Element | null {
  const doc = root.ownerDocument ?? document
  const sel = doc.getSelection?.()
  const anchor = sel?.rangeCount ? sel.anchorNode : null
  if (!anchor || !root.contains(anchor)) return null
  const host =
    anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement
  return host?.closest('[data-block]') ?? null
}

/** Decorate everything under `root` (used for the initial pass, a full-walk mutation batch, and
 *  a resolution/selection-driven re-run). */
export function applyCodeRefs(
  root: ParentNode | null | undefined,
  post: (msg: WebviewMessage) => void,
): void {
  if (!root || typeof (root as ParentNode).querySelectorAll !== 'function')
    return
  const skip = caretBlockOf(root as Element)
  for (const textNode of collectDecoratableTextNodes(root as Element)) {
    if (skip?.contains(textNode)) continue
    decorateTextNode(textNode, post)
  }
  for (const code of (root as ParentNode).querySelectorAll<HTMLElement>(
    'code',
  )) {
    if (isInFencedCodeBlock(code)) continue
    if (skip?.contains(code)) continue
    decorateInlineCode(code, post)
  }
}

/** Task 173/174's scoped counterpart — re-decorate one top-level block instead of the whole
 *  editor (queryIncludingSelf: a scoped block can itself BE the `<code>`/text-bearing element).
 *  Same caret guard as `applyCodeRefs` (must be re-checked here too — this is the path a
 *  same-block keystroke actually takes, via `scopeMutations`' block-scoped branch; a bug found
 *  during self-review had this path skip the guard entirely). Exported (unlike callouts.ts's
 *  equivalent private helper) so this specific guard is unit-testable directly, without depending
 *  on the real MutationObserver/rAF timing correctly landing on the scoped-vs-full branch — that
 *  classification is mutation-scope.test.ts's own job, already covered there. */
export function applyCodeRefsWithin(
  block: Element,
  post: (msg: WebviewMessage) => void,
): void {
  if (hasLiveCaret(block)) return
  for (const textNode of collectDecoratableTextNodes(block))
    decorateTextNode(textNode, post)
  for (const code of queryIncludingSelf<HTMLElement>(block, 'code')) {
    if (isInFencedCodeBlock(code)) continue
    decorateInlineCode(code, post)
  }
}

/**
 * Keep code-ref chips wired as the editor rebuilds its DOM on each edit — same shape as
 * `observeCallouts`: block-scoped (mutation-scope.ts), coalesced per frame, idempotent. Also
 * re-walks on `selectionchange` (so the block the caret just LEFT gets decorated) and registers
 * with code-ref-resolve.ts so a host reply chips newly-resolved paths anywhere in the document.
 * `post` is threaded through to every resolution request. Returns a disposer.
 */
export function observeCodeRefs(
  root: HTMLElement | null | undefined,
  post: (msg: WebviewMessage) => void,
): () => void {
  // No editor root mounted yet — nothing to observe; hand back a no-op
  // disposer so callers can always call the returned teardown unconditionally.
  if (!root)
    return () => {
      /* no-op disposer */
    }
  const run = coalescePerFrameWithRecords((records) => {
    const scope = scopeMutations(records)
    if (scope.full) applyCodeRefs(root, post)
    else for (const block of scope.blocks) applyCodeRefsWithin(block, post)
  })
  const obs = new MutationObserver(run)
  obs.observe(root, { childList: true, subtree: true, characterData: true })
  run([])

  const doc = root.ownerDocument ?? document
  const onSelectionChange = () => run([]) // forces scopeMutations([]) → full:true, see its own doc
  doc.addEventListener('selectionchange', onSelectionChange)
  const unregisterReapply = registerCodeRefReapply(() => run([]))

  return () => {
    obs.disconnect()
    run.cancel()
    doc.removeEventListener('selectionchange', onSelectionChange)
    unregisterReapply()
  }
}
