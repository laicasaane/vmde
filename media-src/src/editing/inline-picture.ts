import { innerVditor } from '../util/inner-vditor'
import { activeModeElement, getCursorSourceOffset } from '../util/source-map'
import { requestCaret } from './caret'
import { checkpointEditorUndo } from './rewrap-command'

export interface InlinePictureInput {
  fallback: string
  alt: string
  dark: string
  light: string
}

interface PictureSource {
  media: string
  srcset: string
}

interface PictureModel {
  sources: PictureSource[]
  src: string
  alt: string
}

interface ParsedTag {
  name: string
  closing: boolean
  attrs: Map<string, string>
}

interface PictureMarkers {
  markers: Element[]
  model: PictureModel
}

export interface InlinePictureInsertion {
  markdown: string
  caret: number
}

interface InlinePictureInsertionDeps {
  setApplying(applying: boolean): void
  postExact(markdown: string): void
  snapshotMarkdown?(): string
  onError(error: unknown): void
}

const RASTER_EXTENSION = /\.(?:apng|avif|gif|jpe?g|png|webp)$/iu
const OWNED = 'data-vmde-inline-picture'
const OWNER = 'data-vmde-inline-picture-owner'
const MARKER = 'data-vmde-inline-picture-marker'
const SAFE_CONTAINER = 'p,h1,h2,h3,h4,h5,h6,td,th,li'
const INSERT_EVENT = 'vmde-insert-picture'

let configured: InlinePictureInsertionDeps | undefined

export function configureInlinePictureInsertion(
  deps: InlinePictureInsertionDeps,
): void {
  configured = deps
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '"':
        return '&quot;'
      case '<':
        return '&lt;'
      default:
        return '&gt;'
    }
  })
}

/** A picture preview is deliberately limited to local/HTTPS raster assets. The authored marker
 * sequence remains visible on reveal, so rejecting a richer shape hides no source and never guesses. */
export function isSafeRasterImageLocation(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects unrenderable control bytes in user-provided asset locations.
  if (!value || value !== value.trim() || /[\u0000-\u001F\u007F]/u.test(value))
    return false
  if (value.startsWith('//')) return false
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(value)?.[1]?.toLowerCase()
  if (scheme && scheme !== 'https') return false
  try {
    const url = new URL(value, 'https://vmde.invalid')
    if (scheme === 'https' && (!url.hostname || url.username || url.password))
      return false
    return RASTER_EXTENSION.test(url.pathname)
  } catch {
    return false
  }
}

export function buildInlinePictureMarkup(
  input: InlinePictureInput,
): string | null {
  if (!isSafeRasterImageLocation(input.fallback)) return null
  const sources: string[] = []
  for (const [media, srcset] of [
    ['(prefers-color-scheme: dark)', input.dark],
    ['(prefers-color-scheme: light)', input.light],
  ] as const) {
    if (!srcset) continue
    if (!isSafeRasterImageLocation(srcset)) return null
    sources.push(
      `<source media="${media}" srcset="${escapeAttribute(srcset)}">`,
    )
  }
  return `<picture>${sources.join('')}<img src="${escapeAttribute(input.fallback)}" alt="${escapeAttribute(input.alt)}"></picture>`
}

/** Plan the exact Markdown splice before Vditor sees it. `insertValue()` parses PICTURE as a
 * block and rewrites its attributes, while setValue + postExact retain this literal inline source. */
export function planInlinePictureInsertion(
  markdown: string,
  offset: number,
  input: InlinePictureInput,
): InlinePictureInsertion | null {
  const source = buildInlinePictureMarkup(input)
  if (
    !source ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > markdown.length
  )
    return null
  return {
    markdown: `${markdown.slice(0, offset)}${source}${markdown.slice(offset)}`,
    caret: offset + source.length,
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: consumes quoted and unquoted HTML attributes without reparsing authored source through innerHTML.
function parseTag(source: string): ParsedTag | null {
  const text = source.startsWith('\u200b') ? source.slice(1) : source
  if (!text.startsWith('<') || !text.endsWith('>')) return null
  let index = 1
  let closing = false
  if (text[index] === '/') {
    closing = true
    index++
  }
  const nameStart = index
  while (/[A-Za-z0-9-]/u.test(text[index] ?? '')) index++
  if (index === nameStart) return null
  const name = text.slice(nameStart, index).toLowerCase()
  const attrs = new Map<string, string>()
  if (closing)
    return text.slice(index, -1).trim() === '' ? { name, closing, attrs } : null
  while (index < text.length - 1) {
    if (!/\s/u.test(text[index] ?? '')) return null
    while (/\s/u.test(text[index] ?? '')) index++
    if (index >= text.length - 1) break
    const attrStart = index
    if (!/[A-Za-z_:]/u.test(text[index] ?? '')) return null
    index++
    while (/[A-Za-z0-9:._-]/u.test(text[index] ?? '')) index++
    if (index === attrStart) return null
    const attrName = text.slice(attrStart, index).toLowerCase()
    while (/\s/u.test(text[index] ?? '')) index++
    let value = ''
    if (text[index] === '=') {
      index++
      while (/\s/u.test(text[index] ?? '')) index++
      const quote = text[index]
      if (quote === '"' || quote === "'") {
        index++
        const valueStart = index
        while (index < text.length - 1 && text[index] !== quote) index++
        if (text[index] !== quote) return null
        value = text.slice(valueStart, index++)
      } else {
        const valueStart = index
        while (index < text.length - 1 && !/\s/u.test(text[index] ?? '')) {
          if (/['"=<>`]/u.test(text[index] ?? '')) return null
          index++
        }
        if (index === valueStart) return null
        value = text.slice(valueStart, index)
      }
    }
    if (attrs.has(attrName)) return null
    attrs.set(attrName, value)
  }
  return { name, closing: false, attrs }
}

function markerTag(marker: Element): ParsedTag | null {
  if (marker.getAttribute('data-type') !== 'html-inline') return null
  // Vditor's editable IR root is itself a `<pre class="vditor-reset">`; only a nested pre/code
  // is literal source context. Treating the root as protected would suppress every real marker.
  if (
    marker.parentElement?.closest('code,pre:not(.vditor-reset),[data-render]')
  )
    return null
  return parseTag(marker.textContent ?? '')
}

function insignificant(node: Node): boolean {
  return (
    node.nodeType === Node.TEXT_NODE &&
    (node.textContent ?? '').replaceAll('\u200b', '').trim() === ''
  )
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validates the ordered PICTURE/SOURCE/IMG marker sequence fail-closed before creating presentation DOM.
function readPicture(open: Element): PictureMarkers | null {
  const openTag = markerTag(open)
  if (!openTag || openTag.closing || openTag.name !== 'picture') return null
  const markers = [open]
  const sources: PictureSource[] = []
  let image: PictureModel | null = null
  for (let node = open.nextSibling; node; node = node.nextSibling) {
    if (insignificant(node)) continue
    if (!(node instanceof Element)) return null
    const tag = markerTag(node)
    if (!tag) return null
    markers.push(node)
    if (tag.closing) {
      if (tag.name !== 'picture' || !image) return null
      return { markers, model: { ...image, sources } }
    }
    if (tag.name === 'source' && !image) {
      const media = tag.attrs.get('media')
      const srcset = tag.attrs.get('srcset')
      if (!media || !srcset || !isSafeRasterImageLocation(srcset)) return null
      sources.push({ media, srcset })
      continue
    }
    if (tag.name === 'img' && !image) {
      const src = tag.attrs.get('src')
      if (!src || !isSafeRasterImageLocation(src)) return null
      image = { src, alt: tag.attrs.get('alt') ?? '', sources: [] }
      continue
    }
    return null
  }
  return null
}

function picturePresentation(
  document: Document,
  model: PictureModel,
  id: string,
): HTMLPictureElement {
  const picture = document.createElement('picture')
  picture.setAttribute(OWNED, '1')
  picture.setAttribute(OWNER, id)
  picture.setAttribute('data-render', '1')
  picture.setAttribute('contenteditable', 'false')
  for (const source of model.sources) {
    const element = document.createElement('source')
    element.setAttribute('media', source.media)
    element.setAttribute('srcset', source.srcset)
    picture.append(element)
  }
  const image = document.createElement('img')
  image.setAttribute('src', model.src)
  image.setAttribute('alt', model.alt)
  picture.append(image)
  return picture
}

function issueId(): string {
  return crypto.getRandomValues(new Uint32Array(2)).join('-')
}

function hide(marker: Element, id: string): void {
  ;(marker as HTMLElement).style.display = 'none'
  marker.setAttribute('aria-hidden', 'true')
  marker.setAttribute(MARKER, id)
}

function show(marker: Element, id: string): void {
  if (marker.getAttribute(MARKER) !== id) return
  ;(marker as HTMLElement).style.removeProperty('display')
  marker.removeAttribute('aria-hidden')
  marker.removeAttribute(MARKER)
}

function decorate(container: Element): void {
  for (const candidate of Array.from(container.children)) {
    const parsed = readPicture(candidate)
    if (!parsed) continue
    const next = parsed.markers.at(-1)?.nextElementSibling
    if (next?.getAttribute(OWNED) === '1') continue
    const id = issueId()
    const preview = picturePresentation(
      container.ownerDocument,
      parsed.model,
      id,
    )
    parsed.markers.at(-1)?.after(preview)
    for (const marker of parsed.markers) hide(marker, id)
  }
}

function rangeTouches(container: Element, range: Range): boolean {
  const bounds = document.createRange()
  bounds.selectNodeContents(container)
  const start = range.cloneRange()
  start.collapse(true)
  const end = range.cloneRange()
  end.collapse(false)
  const first = bounds.cloneRange()
  first.collapse(true)
  const last = bounds.cloneRange()
  last.collapse(false)
  return (
    start.compareBoundaryPoints(Range.START_TO_START, last) < 0 &&
    end.compareBoundaryPoints(Range.START_TO_START, first) > 0
  )
}

function reveal(preview: Element): Element | null {
  const id = preview.getAttribute(OWNER)
  const container = preview.parentElement
  if (!id || !container || preview.getAttribute(OWNED) !== '1') return null
  for (const marker of Array.from(container.querySelectorAll(`[${MARKER}]`)))
    show(marker, id)
  preview.remove()
  return container
}

export function observeInlinePictures(
  root: HTMLElement | null | undefined,
): () => void {
  if (!root) return () => undefined
  let applying = false
  const revealed = new Set<Element>()
  const run = () => {
    if (applying) return
    applying = true
    try {
      for (const container of Array.from(root.querySelectorAll(SAFE_CONTAINER)))
        decorate(container)
    } finally {
      applying = false
    }
  }
  const observer = new MutationObserver(run)
  observer.observe(root, { childList: true, subtree: true })
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: atomically reconciles source reveal and re-decoration for the browser's live selection range.
  const onSelection = () => {
    const selection = document.getSelection()
    if (!selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    for (const preview of Array.from(root.querySelectorAll(`[${OWNED}="1"]`))) {
      if (rangeTouches(preview, range)) {
        const container = reveal(preview)
        if (container) revealed.add(container)
      }
    }
    for (const container of Array.from(revealed)) {
      if (rangeTouches(container, range)) continue
      revealed.delete(container)
      run()
    }
  }
  const onPointer = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null
    const preview = target?.closest(`[${OWNED}="1"]`)
    if (!preview || !root.contains(preview)) return
    const container = reveal(preview)
    if (!container) return
    const firstMarker = container.querySelector(`[${MARKER}]`)
    if (firstMarker) {
      const range = document.createRange()
      range.setStartBefore(firstMarker)
      range.collapse(true)
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    revealed.add(container)
    event.preventDefault()
  }
  document.addEventListener('selectionchange', onSelection)
  root.addEventListener('pointerdown', onPointer)
  root.addEventListener('click', onPointer)
  run()
  return () => {
    observer.disconnect()
    document.removeEventListener('selectionchange', onSelection)
    root.removeEventListener('pointerdown', onPointer)
    root.removeEventListener('click', onPointer)
  }
}

function selectionRange(): Range | null {
  const outer = window.vditor
  if (!outer) return null
  const mode = outer.getCurrentMode()
  const editor = activeModeElement(outer)
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined
  if (range && editor?.contains(range.commonAncestorContainer))
    return range.cloneRange()
  return (
    (outer.vditor?.[mode]?.range as Range | undefined)?.cloneRange() ?? null
  )
}

function restoreRange(range: Range | null): void {
  if (!range?.startContainer.isConnected) return
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  const outer = window.vditor
  const modeState = outer?.vditor[outer.getCurrentMode()]
  if (modeState) modeState.range = range.cloneRange()
}

function previewIsOpen(): boolean {
  return (
    innerVditor()?.toolbar?.elements?.preview?.children[0]?.classList.contains(
      'vditor-menu--current',
    ) === true
  )
}

function appendInput(
  form: HTMLFormElement,
  labelText: string,
  name: keyof InlinePictureInput,
  required = false,
): HTMLInputElement {
  const label = form.ownerDocument.createElement('label')
  label.append(`${labelText} `)
  const input = form.ownerDocument.createElement('input')
  input.name = name
  input.autocomplete = 'off'
  input.required = required
  label.append(input)
  form.append(label)
  return input
}

/** More-menu dialog that inserts one literal PICTURE transaction. It builds chrome through DOM APIs
 * so none of its markup handling can reinterpret authored HTML; the only authored bytes are the
 * validated string passed to Vditor's single insert transaction. */
function openPictureDialog(): void {
  const outer = window.vditor
  if (
    !outer ||
    previewIsOpen() ||
    document.querySelector('[data-vmde-picture-dialog]')
  )
    return
  const range = selectionRange()
  // Capture the source coordinate before the toolbar dialog takes focus; unlike a live DOM Range,
  // this stays meaningful after Vditor rebuilds the IR surface for the exact-source transaction.
  const sourceOffset = getCursorSourceOffset(outer)
  const returnFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  const dialog = document.createElement('form')
  dialog.dataset.vmdePictureDialog = '1'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', 'Insert picture')
  dialog.className = 'vmde-picture-dialog'
  const fallback = appendInput(
    dialog,
    'Fallback image path or URL',
    'fallback',
    true,
  )
  const alt = appendInput(dialog, 'Alt text', 'alt')
  appendInput(dialog, 'Dark image path or URL', 'dark')
  appendInput(dialog, 'Light image path or URL', 'light')
  const error = document.createElement('p')
  error.dataset.vmdePictureError = '1'
  error.setAttribute('aria-live', 'polite')
  dialog.append(error)
  const apply = document.createElement('button')
  apply.type = 'submit'
  apply.textContent = 'Apply'
  dialog.append(apply)
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.dataset.vmdePictureCancel = '1'
  cancel.textContent = 'Cancel'
  dialog.append(cancel)
  document.body.append(dialog)
  const close = () => {
    dialog.remove()
    returnFocus?.focus({ preventScroll: true })
  }
  cancel.addEventListener('click', close)
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  dialog.addEventListener('submit', (event) => {
    event.preventDefault()
    const markup = buildInlinePictureMarkup({
      fallback: fallback.value,
      alt: alt.value,
      dark: (dialog.elements.namedItem('dark') as HTMLInputElement).value,
      light: (dialog.elements.namedItem('light') as HTMLInputElement).value,
    })
    if (!markup) {
      error.textContent =
        'Use a relative or HTTPS PNG, JPEG, GIF, WebP, AVIF, or APNG image path.'
      return
    }
    const markdown = configured?.snapshotMarkdown?.() ?? outer.getValue()
    const offset = sourceOffset >= 0 ? sourceOffset : markdown.length
    const plan = planInlinePictureInsertion(markdown, offset, {
      fallback: fallback.value,
      alt: alt.value,
      dark: (dialog.elements.namedItem('dark') as HTMLInputElement).value,
      light: (dialog.elements.namedItem('light') as HTMLInputElement).value,
    })
    if (!plan) return
    const inner = innerVditor()
    if (configured && inner) {
      try {
        configured.setApplying(true)
        checkpointEditorUndo(inner)
        outer.setValue(plan.markdown)
        checkpointEditorUndo(inner)
        requestAnimationFrame(() => requestCaret({ textOffset: plan.caret }))
      } catch (reason) {
        configured.onError(reason)
        return
      } finally {
        configured.setApplying(false)
      }
      configured.postExact(plan.markdown)
      close()
      return
    }
    // The browser utility harness has no edit-sync controller. Keep its interaction test focused
    // on dialog ownership; production always uses the exact-source branch configured in main.ts.
    outer.focus()
    restoreRange(range)
    outer.insertValue(markup)
    close()
  })
  fallback.focus()
}

/** Install exactly one retained-selection More-menu handler per webview init. */
export function installInlinePictureInsertion(): () => void {
  const listener = () => openPictureDialog()
  document.addEventListener(INSERT_EVENT, listener)
  return () => document.removeEventListener(INSERT_EVENT, listener)
}
