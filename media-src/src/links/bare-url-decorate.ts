// Task 655 — bare URLs (`https://example.com`, `www.example.com`, `user@example.com`) shown as links
// in IR, WYSIWYG, Preview and Split preview. Lute never autolinks in any Vditor mode, so this is a
// DOM post-process built like code-ref-decorate.ts: a MutationObserver per pane, block-scoped via
// mutation-scope.ts, coalesced per frame, skipping the block that holds the caret, re-walking on
// `selectionchange`. What counts as a bare URL is bare-url-match.ts.
//
// Two shapes, because only one of them may be serialized:
//  - IR / WYSIWYG (contenteditable): `<span class="vmde-bare-url" data-bare-url="1"
//    data-bare-url-href="…">url text</span>`. A bare class-only span is transparent to Lute's
//    serializers and spin (measured with the real Lute in bare-url-decorate.test.ts). It must NOT
//    be a real `<a href>`: `VditorIRDOM2Md` / `VditorDOM2Md` would turn the anchor into
//    `[url](url)` and change the saved Markdown. It must not use `data-render` either: Lute would
//    skip the whole subtree and delete the URL text from the saved file (see code-ref-decorate.ts).
//  - Preview / Split preview (read-only, never serialized): `<a class="vmde-bare-url" href="…">`,
//    so the existing anchor click handling and link CSS apply unchanged.
//
// Disabling the setting (`vmde.markdown.autolinkBareUrls`) removes every decoration from every
// observed pane at once (setBareUrlsEnabled) without reopening the editor.

import { coalescePerFrameWithRecords } from '../util/observe-coalesce'
import { scopeMutations } from '../util/mutation-impact'
import { findBareUrls } from './bare-url-match'
import {
  caretBlockOf,
  collectTextNodes,
  hasLiveCaret,
} from './code-ref-decorate'
import { htmlLinkHrefAt } from './html-link'

const CLASS_NAME = 'vmde-bare-url'
const ANCHOR_SELECTOR = `a.${CLASS_NAME}`
const DECORATION_SELECTOR = `[data-bare-url="1"], ${ANCHOR_SELECTOR}`

// Subtrees a bare URL must never be recognised inside: code (inline and fenced), links of every
// kind (real anchors, IR link nodes, link references and their definition block, Task 654's
// decorated raw anchors), raw HTML, math, Vditor's IR marker/preview scaffolding and rendered
// (`data-render`) content, footnote and heading-id markers, wiki and code-ref chips, our own
// decoration, comment text, SVG, and Split View source mode (`.vditor-sv`, which shows source).
// `pre:not(.vditor-reset)`, not bare `pre`: Vditor's IR and WYSIWYG root is itself
// `<pre class="vditor-reset">` (see code-ref-decorate.ts).
const SKIP_SELECTOR =
  'pre:not(.vditor-reset), code, svg, a[href], [data-render], .vditor-ir__marker, .vditor-ir__preview, .vditor-sv, [data-type="a"], [data-type="link-ref"], [data-type="link-ref-defs-block"], [data-type="html-inline"], [data-type="html-block"], [data-type="html-entity"], [data-type="math-inline"], [data-type="math-block"], [data-type="footnotes-ref"], [data-type="heading-id"], [data-vmde-html-link], [data-wiki-link], [data-code-ref], [data-bare-url], .vmde-comment'

let enabled = true
const activeReappliers = new Set<() => void>()

/** Live config change: decorate (or strip) every observed pane immediately. */
export function setBareUrlsEnabled(next: boolean): void {
  if (enabled === next) return
  enabled = next
  for (const reapply of activeReappliers) reapply()
}

function isEditable(node: Node): boolean {
  const host = node.parentElement?.closest('[contenteditable]')
  return (
    host !== null &&
    host !== undefined &&
    host.getAttribute('contenteditable') !== 'false'
  )
}

function decorateTextNode(textNode: Text): void {
  const matches = findBareUrls(textNode.data)
  if (matches.length === 0) return
  const doc = textNode.ownerDocument ?? document
  const editable = isEditable(textNode)
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const tail = textNode.splitText(m.index)
    tail.splitText(m.source.length) // the trailing remainder stays a plain sibling text node
    const el = editable ? doc.createElement('span') : doc.createElement('a')
    el.className = CLASS_NAME
    if (el instanceof HTMLAnchorElement) {
      el.setAttribute('href', m.href)
    } else {
      el.setAttribute('data-bare-url', '1')
      el.setAttribute('data-bare-url-href', m.href)
    }
    el.textContent = tail.data
    tail.replaceWith(el)
  }
}

function decorateAll(textNodes: Text[], skip: Element | null): void {
  for (const textNode of textNodes) {
    if (skip?.contains(textNode)) continue
    // Task 654: text in a raw HTML link body is link text; a second link inside it is wrong.
    if (htmlLinkHrefAt(textNode) !== null) continue
    decorateTextNode(textNode)
  }
}

/** Decorate everything under `root` (initial pass, full-walk batch, selection-driven re-run). */
export function applyBareUrls(root: ParentNode | null | undefined): void {
  if (!enabled || !root || typeof root.querySelectorAll !== 'function') return
  decorateAll(
    collectTextNodes(root as Element, SKIP_SELECTOR),
    caretBlockOf(root as Element),
  )
}

/** Scoped counterpart for one top-level block; the same caret guard as `applyBareUrls`. */
export function applyBareUrlsWithin(block: Element): void {
  if (!enabled || hasLiveCaret(block)) return
  decorateAll(collectTextNodes(block, SKIP_SELECTOR), null)
}

/** Replace every decoration under `root` with its plain text (setting turned off). */
function removeBareUrls(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll(DECORATION_SELECTOR)))
    el.replaceWith(el.textContent ?? '')
}

/**
 * Keep bare URLs decorated as the editor rebuilds its DOM — same shape as `observeCodeRefs`.
 * Returns a disposer. Registers for live setting changes (`setBareUrlsEnabled`).
 */
export function observeBareUrls(
  root: HTMLElement | null | undefined,
): () => void {
  if (!root)
    return () => {
      /* no-op disposer */
    }
  const run = coalescePerFrameWithRecords((records) => {
    if (!enabled) return
    const scope = scopeMutations(records)
    if (scope.full) applyBareUrls(root)
    else for (const block of scope.blocks) applyBareUrlsWithin(block)
  })
  const obs = new MutationObserver(run)
  obs.observe(root, { childList: true, subtree: true, characterData: true })
  const reapply = () => {
    if (enabled) applyBareUrls(root)
    else removeBareUrls(root)
  }
  activeReappliers.add(reapply)
  run([])

  const doc = root.ownerDocument ?? document
  const onSelectionChange = () => run([]) // forces scopeMutations([]) → full:true
  doc.addEventListener('selectionchange', onSelectionChange)

  return () => {
    obs.disconnect()
    run.cancel()
    doc.removeEventListener('selectionchange', onSelectionChange)
    activeReappliers.delete(reapply)
  }
}
