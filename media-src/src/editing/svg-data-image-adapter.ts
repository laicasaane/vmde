import { loadScript } from '../util/load-script'
import {
  countDecoratorPass,
  forEachScopeElement,
  onLiveChange,
  forEachRecordScope,
  writeQuietly,
} from '../util/mutation-impact'
import type { UnitsChange } from '../util/unit-changes'

const MAX_SVG_BYTES = 256 * 1024
const SVG_DATA_PREFIX = 'data:image/svg+xml;base64,'
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const IMG_TAG = /<img\b(?:"[^"]*"|'[^']*'|[^'">])*?>/gi

const SVG_TAGS = [
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'rect',
  'text',
  'tspan',
  'title',
  'desc',
  'defs',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
] as const

const SVG_ATTRIBUTES = [
  'xmlns',
  'viewbox',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'opacity',
  'transform',
  'text-anchor',
  'font-family',
  'font-size',
  'font-weight',
  'dominant-baseline',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'clip-path',
  'clip-rule',
  'mask',
  'id',
] as const

const FORBIDDEN_TAGS = [
  'script',
  'style',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'image',
  'use',
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
] as const
const FORBIDDEN_ATTRIBUTES = ['style', 'href', 'xlink:href'] as const
const ALLOWED_TAGS = new Set<string>(SVG_TAGS)
const ALLOWED_ATTRIBUTES = new Set<string>(SVG_ATTRIBUTES)

interface SvgDomPurify {
  sanitize(source: string, options: Record<string, unknown>): string
}

declare global {
  interface Window {
    DOMPurify?: SvgDomPurify
  }
}

function decodedSvgDataUri(uri: string): string | null {
  if (!uri.startsWith(SVG_DATA_PREFIX)) return null
  const encoded = uri.slice(SVG_DATA_PREFIX.length)
  if (
    encoded.length === 0 ||
    encoded.length > Math.ceil(MAX_SVG_BYTES / 3) * 4 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  )
    return null
  try {
    const binary = atob(encoded)
    if (binary.length > MAX_SVG_BYTES) return null
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each branch is a separate SVG policy rejection and flattening them would obscure the security boundary.
function hasOnlyRestrictedSvgMarkup(svg: string): boolean {
  if (/<!doctype\b/i.test(svg)) return false
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  if (
    doc.doctype ||
    root.localName.toLowerCase() !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg' ||
    doc.querySelector('parsererror')
  )
    return false
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    if (!ALLOWED_TAGS.has(element.localName.toLowerCase())) return false
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim()
      if (
        name.startsWith('on') ||
        FORBIDDEN_ATTRIBUTES.includes(
          name as (typeof FORBIDDEN_ATTRIBUTES)[number],
        ) ||
        !ALLOWED_ATTRIBUTES.has(name)
      )
        return false
      // Local paint-server references are useful and inert; every other url() form can fetch or
      // dereference outside this SVG, so the adapter refuses it before a blob URL exists.
      if (value.includes('url(') && !/^url\(#[A-Za-z][\w:.-]*\)$/.test(value))
        return false
    }
  }
  return true
}

function sanitizeSvgDataUri(uri: string): string | null {
  const decoded = decodedSvgDataUri(uri)
  if (!decoded || !hasOnlyRestrictedSvgMarkup(decoded)) return null
  const clean = window.DOMPurify?.sanitize(decoded, {
    ALLOWED_TAGS: [...SVG_TAGS],
    ALLOWED_ATTR: [...SVG_ATTRIBUTES],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [...FORBIDDEN_TAGS],
    FORBID_ATTR: [...FORBIDDEN_ATTRIBUTES],
  })
  return clean && hasOnlyRestrictedSvgMarkup(clean) ? clean : null
}

function maskImageTag(tag: string): string {
  const template = document.createElement('template')
  template.innerHTML = tag
  const image = template.content.firstElementChild
  if (
    template.content.childElementCount !== 1 ||
    image?.localName !== 'img' ||
    !image.getAttribute('src')?.startsWith(SVG_DATA_PREFIX)
  )
    return tag
  const source = image.getAttribute('src')
  if (!source) return tag
  image.removeAttribute('src')
  image.setAttribute('data-vmde-svg-data', source)
  return image.outerHTML
}

/**
 * Preview-only source adapter. Lute continues to sanitize the actual document; this merely moves
 * a candidate URI into a data attribute that its sanitizer preserves until the render-only pass.
 */
export function maskSvgDataImagesForPreview(markdown: string): string {
  if (!markdown.includes(SVG_DATA_PREFIX)) return markdown
  let fence: string | null = null
  return markdown
    .split('\n')
    .map((line) => {
      const match = FENCE.exec(line)
      if (match) {
        if (!fence) fence = match[1]
        else if (match[1][0] === fence[0] && match[1].length >= fence.length)
          fence = null
        return line
      }
      return fence ? line : line.replace(IMG_TAG, maskImageTag)
    })
    .join('\n')
}

const objectUrls = new WeakMap<HTMLElement, string>()

function renderedPreview(
  source: string,
  image: HTMLImageElement,
): HTMLElement | null {
  const clean = sanitizeSvgDataUri(source)
  if (!clean) return null
  // This wrapper is Lute's native presentation marker. It is deliberately created before the
  // blob URL so the URL can only ever live in a non-editable, non-serializing preview subtree.
  const preview = image.ownerDocument.createElement('span')
  preview.className = 'vmde-svg-data-image'
  preview.dataset.render = '1'
  preview.setAttribute('contenteditable', 'false')
  const rendered = image.ownerDocument.createElement('img')
  rendered.alt = image.alt
  for (const name of ['width', 'height']) {
    const value = image.getAttribute(name)
    if (value) rendered.setAttribute(name, value)
  }
  const url = URL.createObjectURL(
    new Blob([clean], { type: 'image/svg+xml;charset=utf-8' }),
  )
  objectUrls.set(preview, url)
  rendered.src = url
  preview.appendChild(rendered)
  return preview
}

function replaceCandidate(image: HTMLImageElement): void {
  const source = image.getAttribute('data-vmde-svg-data')
  if (!source) return
  const preview = renderedPreview(source, image)
  if (!preview) return
  image.replaceWith(preview)
}

const HTML_BLOCK = '[data-type="html-block"]'
const HTML_INLINE = '[data-type="html-inline"]'

function applyEditableHtmlBlockPreviews(root: ParentNode): void {
  for (const block of Array.from(
    root.querySelectorAll<HTMLElement>(HTML_BLOCK),
  ))
    previewHtmlBlock(block)
}

function previewHtmlBlock(block: HTMLElement): void {
  const source = block.querySelector<HTMLElement>(
    'pre.vditor-ir__marker--pre > code, pre > code',
  )?.textContent
  const preview = block.querySelector<HTMLElement>(
    '.vditor-ir__preview, .vditor-wysiwyg__preview',
  )
  if (!source || !preview || preview.querySelector('.vmde-svg-data-image'))
    return
  const template = block.ownerDocument.createElement('template')
  template.innerHTML = source
  for (const image of Array.from(
    template.content.querySelectorAll<HTMLImageElement>('img[src]'),
  )) {
    const uri = image.getAttribute('src')
    if (!uri) continue
    const rendered = renderedPreview(uri, image)
    // Usually inside `data-render`, which the filter already ignores; quiet in any case, since
    // the selector does not require the attribute.
    if (rendered) writeQuietly(() => preview.appendChild(rendered))
  }
}

function applyEditableHtmlInlinePreviews(root: ParentNode): void {
  for (const marker of Array.from(
    root.querySelectorAll<HTMLElement>(HTML_INLINE),
  ))
    previewHtmlInline(marker)
}

function previewHtmlInline(marker: HTMLElement): void {
  const source =
    marker.localName === 'code'
      ? marker.textContent
      : marker.querySelector('code')?.textContent
  const target = marker.localName === 'code' ? marker.parentElement : marker
  if (!source || !target || target.querySelector('.vmde-svg-data-image')) return
  const template = marker.ownerDocument.createElement('template')
  template.innerHTML = source
  for (const image of Array.from(
    template.content.querySelectorAll<HTMLImageElement>('img[src]'),
  )) {
    const uri = image.getAttribute('src')
    if (!uri) continue
    const rendered = renderedPreview(uri, image)
    // The marker or its parent is not inside `data-render`: quiet.
    if (rendered) writeQuietly(() => target.appendChild(rendered))
  }
}

function revokePreview(preview: HTMLElement): void {
  const url = objectUrls.get(preview)
  if (!url) return
  URL.revokeObjectURL(url)
  objectUrls.delete(preview)
}

function revokeRemovedPreviews(node: Node): void {
  if (node.nodeType !== Node.ELEMENT_NODE) return
  const element = node as HTMLElement
  if (element.matches('.vmde-svg-data-image[data-render="1"]'))
    revokePreview(element)
  for (const preview of Array.from(
    element.querySelectorAll<HTMLElement>(
      '.vmde-svg-data-image[data-render="1"]',
    ),
  ))
    revokePreview(preview)
}

/** Replace only Lute-preserved candidate placeholders; rejected input stays sanitized and blank. */
export function applySvgDataImagePreviews(
  root: ParentNode | null | undefined,
): void {
  if (!root || typeof root.querySelectorAll !== 'function') return
  for (const image of Array.from(
    root.querySelectorAll<HTMLImageElement>('img[data-vmde-svg-data]'),
  ))
    replaceCandidate(image)
  applyEditableHtmlBlockPreviews(root)
  applyEditableHtmlInlinePreviews(root)
}

/** The same pass over one unit element: the element itself and everything inside it. */
function applyWithin(scope: Element): void {
  if (!scope.isConnected) return
  for (const image of Array.from(
    scope.querySelectorAll<HTMLImageElement>('img[data-vmde-svg-data]'),
  ))
    replaceCandidate(image)
  if (scope.matches(HTML_BLOCK)) previewHtmlBlock(scope as HTMLElement)
  applyEditableHtmlBlockPreviews(scope)
  if (scope.matches(HTML_INLINE)) previewHtmlInline(scope as HTMLElement)
  applyEditableHtmlInlinePreviews(scope)
}

/** DOMPurify stays in a local lazy asset: a document without SVG data images does not pay for it. */
function loadSvgDataImageSanitizer(cdn: string): Promise<void> {
  const nonce =
    document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce
  return loadScript(
    `${cdn}/dist/js/dompurify/purify.min.js?v=3.4.13`,
    'vmdeSvgDataImageSanitizer',
    nonce,
  )
}

function blockHasCandidate(block: HTMLElement): boolean {
  return Boolean(
    block
      .querySelector('pre.vditor-ir__marker--pre > code, pre > code')
      ?.textContent?.includes(SVG_DATA_PREFIX),
  )
}

function inlineHasCandidate(inline: HTMLElement): boolean {
  return Boolean(
    (inline.localName === 'code'
      ? inline.textContent
      : inline.querySelector('code')?.textContent
    )?.includes(SVG_DATA_PREFIX),
  )
}

/** `scope` itself counts when it is a block or an inline marker. */
function hasSvgDataImageCandidate(scope: ParentNode): boolean {
  const self = scope instanceof HTMLElement ? scope : undefined
  return Boolean(
    scope.querySelector('img[data-vmde-svg-data]') ||
      (self?.matches(HTML_BLOCK) && blockHasCandidate(self)) ||
      (self?.matches(HTML_INLINE) && inlineHasCandidate(self)) ||
      Array.from(scope.querySelectorAll<HTMLElement>(HTML_BLOCK)).some(
        blockHasCandidate,
      ) ||
      Array.from(scope.querySelectorAll<HTMLElement>(HTML_INLINE)).some(
        inlineHasCandidate,
      ),
  )
}

/** Observe Preview DOM rebuilds and revoke every blob URL when its render-only node disappears. */
export function observeSvgDataImagePreviews(
  root: HTMLElement | null | undefined,
  cdn: string,
): () => void {
  if (!root)
    return () => {
      /* no-op */
    }
  let loading = false
  let unavailable = false
  // Loads the sanitizer once, when `scopes` hold a candidate and it is not available yet.
  const loadIfNeeded = (scopes: readonly ParentNode[]) => {
    if (window.DOMPurify || loading || unavailable) return
    if (!scopes.some(hasSvgDataImageCandidate)) return
    loading = true
    void loadSvgDataImageSanitizer(cdn).then(() => {
      loading = false
      unavailable = !window.DOMPurify
      run()
    })
  }
  // `scope` is the whole root unless a record outside the feed root names a smaller container.
  const run = (scope: Element = root) => {
    if (scope === root) {
      countDecoratorPass('full')
      applySvgDataImagePreviews(root)
    } else {
      countDecoratorPass('scoped')
      applyWithin(scope)
    }
    loadIfNeeded([scope])
  }
  // Task 733: the units of one feed change are the only places that can need a preview.
  const runScoped = (change: Pick<UnitsChange, 'changed' | 'structural'>) => {
    countDecoratorPass('scoped')
    const scope: HTMLElement[] = []
    forEachScopeElement(change, (element) => {
      applyWithin(element)
      scope.push(element)
    })
    loadIfNeeded(scope)
  }
  // Removed previews are always revoked; the whole-root pass runs only when no feed describes this root.
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of Array.from(record.removedNodes))
        revokeRemovedPreviews(node)
    forEachRecordScope(root, records, run)
  })
  observer.observe(root, { childList: true, subtree: true })
  const offFeed = onLiveChange(root, (change) => {
    if (change.whole) run()
    else runScoped(change)
  })
  run()
  return () => {
    observer.disconnect()
    offFeed()
    for (const preview of Array.from(
      root.querySelectorAll<HTMLElement>(
        '.vmde-svg-data-image[data-render="1"]',
      ),
    )) {
      revokePreview(preview)
    }
  }
}
