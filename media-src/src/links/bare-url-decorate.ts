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
import { scopeMutations, writeQuietly } from '../util/mutation-impact'
import { findBareUrls } from './bare-url-match'
import {
  caretBlockOf,
  collectTextNodes,
  hasLiveCaret,
} from './code-ref-decorate'

const CLASS_NAME = 'vmde-bare-url'
const ANCHOR_SELECTOR = `a.${CLASS_NAME}`
const DECORATION_SELECTOR = `[data-bare-url="1"], ${ANCHOR_SELECTOR}`

// Subtrees a bare URL must never be recognised inside: code (inline and fenced), links of every
// kind (real anchors, IR link nodes, link references and their definition block, Task 654's
// decorated raw anchors), raw HTML tokens, math, Vditor's IR marker/preview scaffolding and rendered
// (`data-render`) content, footnote and heading-id markers, wiki and code-ref chips, our own
// decoration, comment text, SVG, Split View source mode (`.vditor-sv`, which shows source), and
// Vditor's and VMDE's own chrome that can share the observed `#app` root (outline, toolbar, panels,
// hints, popovers), the table of contents, and the Preview source containers of diagrams and math
// (`div.language-mermaid`, `.language-math`, ...: any `language-*` class). Text between a raw inline HTML open/close pair is skipped separately
// (`insideHtmlPair`). `pre:not(.vditor-reset)`, not bare `pre`: Vditor's IR and WYSIWYG root is
// itself `<pre class="vditor-reset">` (see code-ref-decorate.ts).
const SKIP_SELECTOR =
  'pre:not(.vditor-reset), code, svg, a[href], [data-render], .vditor-ir__marker, .vditor-ir__preview, .vditor-sv, [data-type="a"], [data-type="link-ref"], [data-type="link-ref-defs-block"], [data-type="html-inline"], [data-type="html-block"], [data-type="html-entity"], [data-type="math-inline"], [data-type="math-block"], [data-type="footnotes-ref"], [data-type="heading-id"], [data-vmde-html-link], [data-wiki-link], [data-code-ref], [data-bare-url], .vmde-comment, .vditor-outline, .vditor-toolbar, .vditor-panel, .vditor-hint, .vditor-tip, .vditor-counter, .vditor-devtools, .vditor-resize, .vmde-link-popover, .vmde-callout-context-panel, .vmde-diagram-controls, .vmde-diagram-fullscreen-stage, .vditor-toc, [data-type="toc-block"], [class^="language-"], [class*=" language-"]'

// Blocks Lute puts inline html-inline nodes in (the same list as html-link.ts).
const HTML_CONTAINER = 'p,h1,h2,h3,h4,h5,h6,td,th,li'
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])
const CLOSE_TAG = /^<\/([A-Za-z][A-Za-z0-9-]*)\s*>$/u
// Quoted attribute values may contain `>`.
const OPEN_TAG =
  /^<([A-Za-z][A-Za-z0-9-]*)(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>$/u

interface TagMark {
  name: string
  closing: boolean
}

function tagMark(child: ChildNode): TagMark | null {
  if (
    !(child instanceof Element) ||
    child.getAttribute('data-type') !== 'html-inline'
  )
    return null
  const text = (child.textContent ?? '').replace(/\u200b/gu, '')
  const close = CLOSE_TAG.exec(text)
  if (close) return { name: close[1].toLowerCase(), closing: true }
  const open = OPEN_TAG.exec(text)
  const name = open?.[1].toLowerCase()
  if (!name || VOID_TAGS.has(name) || /\/\s*>$/u.test(text)) return null
  return { name, closing: false }
}

// The direct child of `container` that holds `node`, or null.
function branchOf(container: Element, node: Node): ChildNode | null {
  let branch: Node = node
  while (branch.parentNode && branch.parentNode !== container)
    branch = branch.parentNode
  return branch.parentNode === container ? (branch as ChildNode) : null
}

// Raw inline tags opened (and not yet closed) among the siblings before `branch`, outermost first.
function openTagsBefore(container: Element, branch: ChildNode): string[] {
  const open: string[] = []
  for (const child of Array.from(container.childNodes)) {
    if (child === branch) break
    const mark = tagMark(child)
    if (!mark) continue
    if (!mark.closing) open.push(mark.name)
    else {
      const at = open.lastIndexOf(mark.name)
      if (at >= 0) open.length = at
    }
  }
  return open
}

// True when a close tag for `name` follows `branch`, counting nested same-name tags.
function closesAfter(branch: ChildNode, name: string): boolean {
  let depth = 1
  for (let next = branch.nextSibling; next; next = next.nextSibling) {
    const mark = tagMark(next)
    if (mark?.name !== name) continue
    depth += mark.closing ? -1 : 1
    if (depth === 0) return true
  }
  return false
}

/**
 * True when `node` sits between a raw inline HTML open tag and its close tag in the same block
 * (Lute emits each tag as its own html-inline node and leaves the body as plain siblings, so no
 * element wraps it). That body is HTML content, not Markdown prose; an unclosed open tag does not
 * count.
 */
function insideHtmlPair(node: Node): boolean {
  const container = node.parentElement?.closest(HTML_CONTAINER)
  const branch = container ? branchOf(container, node) : null
  if (!container || !branch) return false
  // Any enclosing open tag that closes after the text, not only the innermost: `<kbd><span> u</kbd>`.
  return openTagsBefore(container, branch).some((name) =>
    closesAfter(branch, name),
  )
}

let enabled = true
const activeReappliers = new Set<() => void>()

/** Live config change: decorate (or strip) every observed pane immediately. */
export function setBareUrlsEnabled(next: boolean): void {
  if (enabled === next) return
  enabled = next
  for (const reapply of activeReappliers) reapply()
}

// Read-only Preview and Split preview text lives under Vditor's `.vditor-preview` element; only
// there may a real anchor go in. Every other text node (IR, WYSIWYG, anything a shared root holds)
// gets the span, so an edit surface can never receive an anchor Lute would serialize as `[url](url)`.
function inPreview(node: Node): boolean {
  return node.parentElement?.closest('.vditor-preview') != null
}

function decorateTextNode(textNode: Text): void {
  const matches = findBareUrls(textNode.data)
  if (matches.length === 0) return
  const doc = textNode.ownerDocument ?? document
  const preview = inPreview(textNode)
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const tail = textNode.splitText(m.index)
    tail.splitText(m.source.length) // the trailing remainder stays a plain sibling text node
    const el = preview ? doc.createElement('a') : doc.createElement('span')
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
  const targets = textNodes.filter(
    (textNode) =>
      !skip?.contains(textNode) &&
      findBareUrls(textNode.data).length > 0 &&
      !insideHtmlPair(textNode),
  )
  if (targets.length === 0) return
  writeQuietly(() => {
    for (const textNode of targets) decorateTextNode(textNode)
  })
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
// The block that holds the live caret keeps its decoration until the next pass, as the decorator
// itself skips that block: replacing the span would move the caret. `selectionchange` re-runs the
// strip once the caret has left.
function removeBareUrls(root: Element): void {
  const skip = caretBlockOf(root)
  const found = Array.from(root.querySelectorAll(DECORATION_SELECTOR)).filter(
    (el) => !skip?.contains(el),
  )
  if (found.length === 0) return
  writeQuietly(() => {
    for (const el of found) el.replaceWith(el.textContent ?? '')
  })
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
  const sync = (target: HTMLElement) =>
    enabled ? applyBareUrls(target) : removeBareUrls(target)
  const run = coalescePerFrameWithRecords((records) => {
    const scope = scopeMutations(records)
    // Disabled: strip instead of returning. An Undo restores `innerHTML` from a snapshot that may
    // have been taken while the setting was on, so a decoration can come back after the live strip.
    if (scope.full) sync(root)
    else
      for (const block of scope.blocks) {
        if (enabled) applyBareUrlsWithin(block)
        else removeBareUrls(block)
      }
  })
  const obs = new MutationObserver(run)
  obs.observe(root, { childList: true, subtree: true, characterData: true })
  const reapply = () => sync(root)
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
