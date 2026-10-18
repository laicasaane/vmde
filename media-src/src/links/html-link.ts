// Task 654 — pure recognition of an inline raw HTML anchor (`<a href="…">…</a>`) in the IR and
// WYSIWYG DOM. Lute renders each tag as its own `html-inline` node and the link body as plain
// siblings (no element wraps it), so the reader in editing/html-subscript.ts decorates the body
// and asks this module two questions: "is this open token a link Preview would render?" and "is
// the caret inside such a link's body?". No state, no DOM mutation. Lives in links/ so editing/
// may import it (editing -> links is an allowed edge; the reverse would be a cycle, so the tag
// grammar below is deliberately self-contained instead of importing editing/html-inline-token).

// Selector of the blocks Lute puts inline html-inline nodes in; same list html-subscript.ts pairs.
const CONTAINER = 'p,h1,h2,h3,h4,h5,h6,td,th,li'

// Preview's sanitizer drops `href` for these prefixes (verified against the vendored Lute with
// SetSanitize(true)), leaving a bare `<a>`. A pane must not show such an anchor as a link either.
const DROPPED_BY_PREVIEW = [
  'javascript',
  'data:text/html',
  'data:image/svg+xml',
]

const OPEN_ANCHOR = /^<a[\s>].*>$/isu
const SELF_CLOSING = /\/\s*>$/u
const CLOSE_ANCHOR = /^<\/a\s*>$/iu

function sanitizerDropsHref(href: string): boolean {
  // Mirrors the sanitizer's tolerance: control characters and spaces inside the scheme do not
  // stop a browser from reading it, so they are removed before the prefix check.
  const compact = Array.from(href)
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      // Unicode spaces (NBSP, ideographic space, ...) are dropped as well, as Preview does.
      return code > 0x20 && code !== 0x7f && !/\s/u.test(ch)
    })
    .join('')
    .toLowerCase()
  return DROPPED_BY_PREVIEW.some((prefix) => compact.startsWith(prefix))
}

/**
 * The decoded href of an `html-inline` OPEN token that Preview renders as a link, or null when it
 * must keep its source look (no `href`, a sanitized-away scheme, not an `<a>` open tag). `''` is a
 * valid result: Preview keeps `<a href="">`.
 */
export function htmlAnchorHref(token: string): string | null {
  const source = token.startsWith('\u200b') ? token.slice(1) : token
  if (!OPEN_ANCHOR.test(source) || SELF_CLOSING.test(source)) return null
  // An inert <template> gives the browser's own attribute and entity decoding (`&amp;` -> `&`),
  // the same value Preview's raw-href reads, without running anything. Exactly one child proves
  // the token was one complete open tag and nothing trailed it.
  const template = document.createElement('template')
  template.innerHTML = source
  const anchor = template.content.firstElementChild
  if (
    template.content.childNodes.length !== 1 ||
    anchor?.tagName !== 'A' ||
    !anchor.hasAttribute('href')
  )
    return null
  const href = anchor.getAttribute('href') ?? ''
  return sanitizerDropsHref(href) ? null : href
}

/**
 * The decorated link span around `el`, only when it is one the editor reader made: inside the IR or
 * WYSIWYG surface, not inside rendered content (`[data-render]`, e.g. an HTML block preview) and
 * carrying an owner id. Authored markup with the same attributes must never be trusted as a link
 * target (Task 654).
 */
export function ownedHtmlLinkSpan(el: Element | null): HTMLElement | null {
  const span = el?.closest<HTMLElement>('[data-vmde-html-link="1"]') ?? null
  if (
    !span?.getAttribute('data-vmde-html-link-owner') ||
    !span.closest('.vditor-ir, .vditor-wysiwyg') ||
    span.closest('[data-render]')
  )
    return null
  return span
}

interface AnchorMark {
  closing: boolean
  href: string | null
}

function anchorMark(child: ChildNode): AnchorMark | null {
  if (
    !(child instanceof Element) ||
    child.getAttribute('data-type') !== 'html-inline'
  )
    return null
  const text = (child.textContent ?? '').replace(/^\u200b/u, '')
  if (CLOSE_ANCHOR.test(text)) return { closing: true, href: null }
  // An open anchor that is not accepted still counts for depth, with a null href.
  return OPEN_ANCHOR.test(text)
    ? { closing: false, href: htmlAnchorHref(text) }
    : null
}

// True when a `</a>` that closes the anchor opened before `from` exists among the later siblings
// (an a-only depth count, so a stray nested open tag cannot steal the close).
function closesLater(from: ChildNode | null): boolean {
  let depth = 1
  for (let node = from; node; node = node.nextSibling) {
    const mark = anchorMark(node)
    if (!mark) continue
    depth += mark.closing ? -1 : 1
    if (depth === 0) return true
  }
  return false
}

// The direct child of `container` that holds `node`, or null when `node` is not inside it.
function branchOf(container: Element, node: Node): ChildNode | null {
  let branch: Node = node
  while (branch.parentNode && branch.parentNode !== container)
    branch = branch.parentNode
  return branch.parentNode === container ? (branch as ChildNode) : null
}

// The href of the innermost accepted open anchor before `branch` in `container` (null when the
// innermost is unaccepted or none is open), by an a-only depth count over the direct children.
function openHrefBefore(container: Element, branch: ChildNode): string | null {
  const stack: Array<string | null> = []
  for (
    let child = container.firstChild;
    child && child !== branch;
    child = child.nextSibling
  ) {
    const mark = anchorMark(child)
    if (!mark) continue
    if (mark.closing) stack.pop()
    else stack.push(mark.href)
  }
  return stack.at(-1) ?? null
}

/**
 * The href of the accepted `<a href>` whose body strictly contains `node`, or null. The body is
 * the run of siblings between the open and the close marker inside the same block; the markers
 * themselves, text outside the pair and an unclosed `<a>` give null. A node inside an already
 * decorated link span answers from its attribute, so the lookup does not depend on whether the
 * reader has revealed the source yet.
 */
export function htmlLinkHrefAt(node: Node | null): string | null {
  if (!node) return null
  const start = node instanceof Element ? node : node.parentElement
  const decorated = ownedHtmlLinkSpan(start)
  if (decorated) return decorated.dataset.vmdeHtmlLinkHref ?? null
  const container = start?.closest(CONTAINER)
  const branch = container ? branchOf(container, node) : null
  if (!container || !branch || anchorMark(branch)) return null
  const href = openHrefBefore(container, branch)
  return href !== null && closesLater(branch.nextSibling) ? href : null
}
