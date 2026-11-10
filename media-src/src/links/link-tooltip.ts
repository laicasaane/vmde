// Task 731 — hovering a link or an image shows its target as written, in IR, WYSIWYG, Split's
// preview pane and Preview. Task 732 — the text shows in the toolbar-style hover box
// (chrome/hover-tip.ts), not in a native `title` tooltip.
//
// WHY NOTHING IS WRITTEN UNDER AN EDITOR ROOT: Lute reads the `title` of a WYSIWYG `<a>` / `<img>`
// back as the Markdown link title (`<a title="x" href="b.md">` serializes as `[a](b.md "x")`,
// measured with the vendored Lute in link-tooltip.test.ts), and every attribute write under the
// editor root also lands in Vditor's Undo snapshots and invalidates the observers that cache
// serialized state (edit-sync's rendered memo, the source block index). The hover box lives on
// `<body>`, outside every serialized root. An element in IR or WYSIWYG that already carries its own
// `title` (a WYSIWYG link or image with a Markdown title, a wiki chip, a code reference) keeps its
// native tooltip and gets no box, so the two never show together.
//
// Preview and Split's preview pane are never serialized, so there a hovered `<a>` / `<img>` loses
// its Markdown `title` while hovered (the box already shows it on its first line) and gets it back
// when the pointer leaves.

import { ownedHtmlLinkSpan } from './html-link'
import { rawHrefOf } from './raw-href'
import { resolveReferenceDefinition } from './reference-source'

type LinkTooltipSurface = 'editor' | 'preview'

export interface LinkTooltip {
  element: HTMLElement
  text: string
  surface: LinkTooltipSurface
}

type TitleReader = (element: Element) => string | null

// Lute and the chip templates put zero-width spaces next to inline nodes as caret anchors; they are
// never part of what the author wrote. Line breaks are LF only.
function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\u200b/g, '').replace(/\r\n?/g, '\n')
}

function joinLines(lines: string[]): string | null {
  const kept = lines.filter((line) => line.trim() !== '')
  return kept.length ? kept.join('\n') : null
}

/** A link's tooltip: its Markdown title (when present) on the first line, the destination last. */
export function linkTooltipText(
  title: string | null | undefined,
  destination: string,
): string | null {
  return joinLines([clean(title), clean(destination)])
}

/**
 * An image's tooltip: its title, its alt text and its target as written, each when present, the
 * target always last. A title and alt text that are the same text show once (Task 731 D5).
 */
export function imageTooltipText(
  title: string | null | undefined,
  alt: string | null | undefined,
  target: string,
): string | null {
  const shownTitle = clean(title)
  const shownAlt = clean(alt)
  return joinLines([
    shownTitle,
    shownAlt.trim() === shownTitle.trim() ? '' : shownAlt,
    clean(target),
  ])
}

/**
 * The text of a Markdown title as IR shows it in its marker (`"Title"`, `'Title'`, `(Title)`):
 * the delimiters removed and backslash escapes of ASCII punctuation resolved, as Preview renders it.
 */
export function unquoteMarkdownTitle(source: string): string {
  const text = source.trim()
  const open = text[0]
  const close = { '"': '"', "'": "'", '(': ')' }[open]
  const inner =
    close && text.length >= 2 && text.endsWith(close) ? text.slice(1, -1) : text
  return inner.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

// Vditor's SV root is `<pre class="vditor-sv vditor-reset">` (it shows source, so it has no links
// to explain); IR and WYSIWYG roots are `.vditor-ir > .vditor-reset` / `.vditor-wysiwyg > …`, and
// Preview and Split's preview pane share `.vditor-preview .vditor-reset`.
const SURFACE = '.vditor-ir, .vditor-wysiwyg, .vditor-preview, .vditor-sv'

function surfaceOf(element: Element): LinkTooltipSurface | null {
  if (!element.closest('.vditor-reset')) return null
  const surface = element.closest(SURFACE)
  if (!surface || surface.classList.contains('vditor-sv')) return null
  return surface.classList.contains('vditor-preview') ? 'preview' : 'editor'
}

// Every shape a Markdown link takes in the four surfaces (the same family as caret-link.ts's
// LINK_LIKE_SELECTOR, plus IR's reference node and Task 654's decorated raw HTML anchor).
const LINK =
  '[data-wiki-link="1"], [data-code-ref="1"], [data-bare-url="1"], a.vmde-bare-url, [data-vmde-html-link="1"], a[href], [data-type="a"], [data-type="link-ref"]'
// Diagram, math and code renders draw their own `<img>`, `<a>` and SVG; they are renderer output,
// not Markdown links or images.
const RENDERER_OUTPUT = '[class^="language-"], [class*=" language-"], svg'

function markerText(node: Element, kind: 'link' | 'title'): string {
  return (
    node.querySelector(`:scope > .vditor-ir__marker--${kind}`)?.textContent ??
    ''
  )
}

function markerTitle(node: Element): string | null {
  const marker = markerText(node, 'title')
  return marker ? unquoteMarkdownTitle(marker) : null
}

// The label of a reference link: WYSIWYG carries it as `data-link-label`; IR shows a full
// reference's label in its `[label]` marker and a collapsed or shortcut one only as the link text.
function referenceLabel(node: HTMLElement): string {
  if (node.dataset.linkLabel !== undefined) return node.dataset.linkLabel
  const marker = markerText(node, 'link')
  if (marker) return marker.replace(/^\[|\]$/g, '')
  return Array.from(node.children)
    .filter((child) => !child.classList.contains('vditor-ir__marker'))
    .map((child) => child.textContent ?? '')
    .join('')
}

// A reference link's destination comes from its definition, which IR and WYSIWYG keep as
// editable source text in `link-ref-defs-block` nodes of the same editor root. Preview renders
// reference links as ordinary resolved anchors and never reaches this.
function referenceTooltip(node: HTMLElement): string | null {
  const root = node.closest('.vditor-reset')
  if (!root) return null
  const definitions = Array.from(
    root.querySelectorAll('[data-type="link-ref-defs-block"]'),
    (block) => clean(block.textContent),
  ).join('\n')
  const found = resolveReferenceDefinition(definitions, referenceLabel(node))
  return found
    ? linkTooltipText(
        found.title === null ? null : unquoteMarkdownTitle(found.title),
        found.destination,
      )
    : null
}

function linkTooltip(link: HTMLElement, readTitle: TitleReader): string | null {
  // Wiki chips (custom-renderer.ts, wiki-keys.ts) and code references (code-ref-decorate.ts) already
  // carry their own tooltip naming their target; Task 636's chip state lives in it.
  if (link.matches('[data-wiki-link="1"], [data-code-ref="1"]')) return null
  // A bare URL is its own text; its href may be normalized (`www.` gains `http://`).
  if (link.matches('[data-bare-url="1"], a.vmde-bare-url'))
    return linkTooltipText(null, link.textContent ?? '')
  if (link.matches('[data-vmde-html-link="1"]'))
    return ownedHtmlLinkSpan(link) === link
      ? linkTooltipText(null, link.dataset.vmdeHtmlLinkHref ?? '')
      : null
  // The raw attribute, never `.href` (the resolved webview URL; see raw-href.ts).
  if (link.matches('a[href]'))
    return linkTooltipText(readTitle(link), rawHrefOf(link))
  // IR renders `[text](dest "title")` as marker spans: the destination and title are their text.
  if (link.matches('[data-type="a"]'))
    return linkTooltipText(markerTitle(link), markerText(link, 'link'))
  return referenceTooltip(link)
}

function imageTooltip(image: Element, readTitle: TitleReader): string | null {
  if (image.matches('[data-type="img"]')) {
    const img = image.querySelector(':scope > img')
    return imageTooltipText(
      markerTitle(image),
      img?.getAttribute('alt'),
      markerText(image, 'link'),
    )
  }
  return imageTooltipText(
    readTitle(image),
    image.getAttribute('alt'),
    image.getAttribute('src') ?? '',
  )
}

function imageAt(start: Element): HTMLElement | null {
  const image =
    start.closest<HTMLElement>('[data-type="img"]') ??
    start.closest<HTMLElement>('img')
  return image && !image.closest(RENDERER_OUTPUT) ? image : null
}

const ownTitle: TitleReader = (element) => element.getAttribute('title')

/**
 * The tooltip of the link or image under `node`, or null. An image inside a link answers for the
 * image; the rest of the link answers for the link. `readTitle` lets the hover wiring read the
 * Markdown title it replaced on a Preview element.
 */
export function tooltipAt(
  node: Node | null,
  readTitle: TitleReader = ownTitle,
): LinkTooltip | null {
  const start = node instanceof Element ? node : (node?.parentElement ?? null)
  const surface = start ? surfaceOf(start) : null
  if (!start || !surface) return null
  const link = start.closest<HTMLElement>(LINK)
  const image = imageAt(start)
  if (image && (!link || link.contains(image))) {
    const text = imageTooltip(image, readTitle)
    return text ? { element: image, text, surface } : null
  }
  if (!link || link.closest(RENDERER_OUTPUT)) return null
  const text = linkTooltip(link, readTitle)
  return text ? { element: link, text, surface } : null
}

// True when an element between `from` and the surface root has its own `title`: the browser shows
// that native tooltip there, so a hover box would double it (Task 732 D5).
function shadowedByOwnTitle(from: Element): boolean {
  for (
    let element: Element | null = from;
    element && !element.classList.contains('vditor-reset');
    element = element.parentElement
  ) {
    if (element.getAttribute('title')) return true
  }
  return false
}

/** The hover-box installer (chrome/hover-tip.ts `installHoverTips`), passed in by boot so this
 *  module keeps no edge to `chrome` (module-boundaries allowlist). */
type HoverTipsInstaller = (
  doc: Document,
  resolve: (target: Element) => { element: Element; text: string } | null,
  onTarget?: (element: Element | null) => void,
) => () => void

interface PreviewSuppression {
  element: Element
  original: string
}

/**
 * Show link and image tooltips in the toolbar-style hover box (Task 732) while the pointer is over
 * them, anywhere in `doc`'s IR, WYSIWYG and preview surfaces. Returns a disposer. Pointer events
 * only: keyboard, focus and caret are never read or written, and nothing under an editor root is
 * written.
 */
export function installLinkTooltips(
  doc: Document,
  installHoverTips: HoverTipsInstaller,
): () => void {
  let suppressed: PreviewSuppression | null = null

  // The Markdown title of a Preview element whose `title` is removed while it is hovered.
  const readTitle: TitleReader = (element) =>
    suppressed?.element === element && !element.hasAttribute('title')
      ? suppressed.original
      : element.getAttribute('title')

  const restore = () => {
    if (!suppressed) return
    const { element, original } = suppressed
    suppressed = null
    // A Preview re-render may have written the attribute meanwhile; leave it then.
    if (!element.hasAttribute('title')) element.setAttribute('title', original)
  }

  // Preview is never serialized: its Markdown `title` is taken off the hovered `<a>` / `<img>` so
  // the native tooltip does not double the box, and put back when the pointer leaves (D4).
  const onTarget = (element: Element | null) => {
    if (suppressed?.element === element) return
    restore()
    if (!element?.matches('a, img')) return
    if (surfaceOf(element) !== 'preview') return
    const original = element.getAttribute('title')
    if (!original) return
    element.removeAttribute('title')
    suppressed = { element, original }
  }

  const resolve = (target: Element) => {
    const tip = tooltipAt(target, readTitle)
    if (!tip) return null
    if (tip.surface === 'editor' && shadowedByOwnTitle(target)) return null
    return tip
  }

  const uninstall = installHoverTips(doc, resolve, onTarget)
  return () => {
    uninstall()
    restore()
  }
}
