// HTML comment previews — make `<!-- ... -->` visible in IR, WYSIWYG, and Preview.
//
// Lute renders a markdown HTML comment as a `data-type="html-block"` dual-node whose preview
// holds the LITERAL HTML comment — browsers don't display it, so the comment is invisible when
// collapsed (caret outside). We replace the preview's content with styled text showing the
// comment body. Idempotent (signature guard); round-trip safe (Lute serializes from the source
// marker only, ignores the preview subtree).
//
// In the full Preview pane, Lute emits raw HTML → comments are DOM Comment nodes (nodeType 8),
// not wrapped in `data-type`. A separate walker replaces those with visible elements.

import { coalescePerFrame } from '../util/observe-coalesce'
import {
  observeScopedMutations,
  queryIncludingSelf,
} from '../util/mutation-impact'

// Fence open/close: up to 3 leading spaces, then 3+ backticks or tildes (CommonMark).
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
}

/**
 * Preview pane ONLY: rewrite each block-level `<!-- … -->` into a `<div class="vmde-comment">`
 * carrying the same text the IR pane shows.
 *
 * Why this exists: the preview render runs Lute with `sanitize: true`, and Lute's sanitiser DROPS
 * HTML comments outright — measured, the authored comments were absent from the Preview pane's DOM
 * entirely, not merely invisible (task 367). The IR path (`SpinVditorIRDOM`) keeps them, so the two
 * panes disagreed about whether a whole block exists. Sanitising is NOT the thing to switch off (it
 * is what strips `<script>`/`onclick` from a hostile document); a `<div class data-*>` survives it
 * intact, so we hand Lute something it will keep.
 *
 * Operates on the markdown SOURCE, so:
 * - it must not touch a comment inside a fenced code block, where `<!-- … -->` is literal text the
 *   reader asked to see — hence the fence tracking rather than a bare regex over the document;
 * - it is preview-only. The saved document is serialised from the editor's own DOM, never from
 *   this string.
 *
 * Comments that merely appear mid-paragraph are left alone: they are inline content, and rewriting
 * them would reflow the paragraph around a block element.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: scans for HTML comments across code-fence/code-span-guard state while masking; pre-existing (task 469 baseline)
export function maskCommentsForPreview(md: string): string {
  if (!md.includes('<!--')) return md
  const lines = md.split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const f = FENCE.exec(line)
    if (f) {
      // Closing fence must be at least as long as the opener and of the same character.
      if (!fence) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      out.push(line)
      continue
    }
    if (fence || !line.trimStart().startsWith('<!--')) {
      out.push(line)
      continue
    }
    // A comment block: from this line up to the one closing it. An unterminated comment runs to
    // the end of the document, which is what a markdown renderer does with it too.
    let end = i
    while (end < lines.length && !lines[end].includes('-->')) end++
    const raw = lines.slice(i, Math.min(end + 1, lines.length)).join('\n')
    const text = raw.trim().replace(/^<!--/, '').replace(/-->$/, '').trim()
    const safe = `<!-- ${text || '(empty)'} -->`.replace(
      /[&<>]/g,
      (c) => ESCAPE[c],
    )
    out.push(`<div class="vmde-comment" data-vmde-comment="1">${safe}</div>`)
    i = end
  }
  return out.join('\n')
}
const COMMENT_CLOSED = /^<!--([\s\S]*?)-->$/
const COMMENT_OPEN = /^<!--([\s\S]*)$/

function extractComment(
  source: string,
): { text: string; closed: boolean } | null {
  const s = source.trim()
  const mc = COMMENT_CLOSED.exec(s)
  if (mc) return { text: mc[1].trim(), closed: true }
  const mo = COMMENT_OPEN.exec(s)
  if (mo) return { text: mo[1].trim(), closed: false }
  return null
}

// Shared per-block worker for applyCommentPreviews / applyCommentPreviewsWithin (task 173).
function decorateHtmlBlock(block: HTMLElement): void {
  const code = block.querySelector<HTMLElement>(
    'pre.vditor-ir__marker--pre > code, pre > code',
  )
  if (!code) return
  const source = code.textContent || ''
  const comment = extractComment(source)
  if (!comment) return

  const preview = block.querySelector<HTMLElement>(
    '.vditor-ir__preview, .vditor-wysiwyg__preview',
  )
  if (!preview) return
  if (preview.dataset.vmdeCommentSig === source) return

  const doc = block.ownerDocument
  const span = doc.createElement('span')
  span.className = 'vmde-comment'
  const body = comment.text || '(empty)'
  span.textContent = comment.closed ? `<!-- ${body} -->` : `<!-- ${body}`
  preview.textContent = ''
  preview.appendChild(span)
  preview.dataset.vmdeCommentSig = source
}

/**
 * IR / WYSIWYG: inject visible text into the preview element of each html-block comment.
 * Non-comment html-blocks (`<div>`, `<audio>`, …) are left alone — their preview already renders.
 */
export function applyCommentPreviews(
  root: ParentNode | null | undefined,
): void {
  if (!root || typeof root.querySelectorAll !== 'function') return
  for (const block of Array.from(
    root.querySelectorAll<HTMLElement>('[data-type="html-block"]'),
  ))
    decorateHtmlBlock(block)
}

/**
 * Task 173: the scoped counterpart of `applyCommentPreviews` — re-decorate html-block comments inside
 * a single top-level block. `queryIncludingSelf` because the scoped block CAN itself carry
 * `data-type="html-block"` (a top-level comment) — plain `querySelectorAll` only finds descendants.
 */
function applyCommentPreviewsWithin(block: Element): void {
  for (const el of queryIncludingSelf<HTMLElement>(
    block,
    '[data-type="html-block"]',
  ))
    decorateHtmlBlock(el)
}

/**
 * Full Preview pane: Lute emits raw HTML, so comments are DOM Comment nodes (no wrapper).
 * Replace each with a visible element. Safe to re-run — Comment nodes are gone after the first
 * pass; fresh preview renders re-inject them from Lute output.
 */
export function revealPreviewComments(
  root: HTMLElement | null | undefined,
): void {
  if (!root) return
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_COMMENT,
    {
      // Never descend into a rendered diagram. Graphviz carries the DOT source's own comments
      // through into its SVG output (`<!-- A -->` for each node), and replacing those with a <div>
      // both injects invalid content into an <svg> and made the Preview pane's graphviz markup
      // differ from the IR pane's, where this pass does not run (task 366 probe).
      acceptNode: (n) =>
        n.parentElement?.closest('svg')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    },
  )
  const comments: Comment[] = []
  let node: Comment | null
  while (true) {
    node = walker.nextNode() as Comment | null
    if (!node) break
    comments.push(node)
  }
  for (const c of comments) {
    const text = (c.textContent ?? '').trim()
    const el = root.ownerDocument.createElement('div')
    el.className = 'vmde-comment'
    el.setAttribute('contenteditable', 'false')
    el.textContent = `<!-- ${text || '(empty)'} -->`
    c.parentNode?.replaceChild(el, c)
  }
}

// Both observers coalesce same-frame mutation bursts (leading sync run + one pre-paint
// trailing re-run — coalescePerFrame, 185/2c). applyCommentPreviews replaces comment nodes
// inside the observed subtree; convergence relies on the replacement <div> no longer being
// a comment (idempotent), the coalescing just bounds how often the walk runs per frame.
//
// Task 173/174: observeHtmlComments (the IR/WYSIWYG editor, before-paint) is scoped to the top-level
// block(s) a batch touched instead of a whole-`editorEl` walk, and drops batches that are entirely our
// own comment-span injections — see mutation-scope.ts. observePreviewComments below is untouched: it
// walks Comment nodes in the full-Preview pane, a different mechanism task 173 didn't name.
export function observeHtmlComments(
  editorEl: HTMLElement | null | undefined,
): () => void {
  // No editor root mounted yet — nothing to observe; hand back a no-op
  // disposer so callers can always call the returned teardown unconditionally.
  if (!editorEl)
    return () => {
      /* no-op disposer */
    }
  return observeScopedMutations(
    editorEl,
    {
      full: applyCommentPreviews,
      within: applyCommentPreviewsWithin,
    },
    // Task 733 / 031: a cell or item change rescans that cell or item, not its whole table or list.
    { scope: 'unit' },
  )
}

export function observePreviewComments(
  previewEl: HTMLElement | null | undefined,
): () => void {
  // No preview pane mounted yet — nothing to observe; hand back a no-op
  // disposer so callers can always call the returned teardown unconditionally.
  if (!previewEl)
    return () => {
      /* no-op disposer */
    }
  const run = coalescePerFrame(() => revealPreviewComments(previewEl))
  const obs = new MutationObserver(run)
  obs.observe(previewEl, { childList: true, subtree: true })
  run()
  return () => {
    obs.disconnect()
    run.cancel()
  }
}
