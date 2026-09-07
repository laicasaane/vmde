import {
  isCompositionActive,
  subscribeCompositionState,
} from '../util/caret-gesture'
import { parseHtmlInlineToken } from './html-inline-token'

const OWNED = 'data-vmde-html-subscript'
const OWNED_SELECTOR = `sub[${OWNED}="1"]`
const REVEALED = 'data-vmde-html-subscript-revealed'
const OWNER = 'data-vmde-html-subscript-owner'
const MARKER = 'data-vmde-html-subscript-marker'
const STATE = Symbol.for('vmde.htmlSubscript.presentation')

interface Ownership {
  token: string
  next: number
  issued: Set<string>
}
function ownership(): Ownership {
  const host = globalThis as typeof globalThis & { [STATE]?: Ownership }
  if (!host[STATE]) {
    const r = crypto.getRandomValues(new Uint32Array(2))
    host[STATE] = {
      token: `${r[0].toString(36)}${r[1].toString(36)}`,
      next: 0,
      issued: new Set(),
    }
  }
  return host[STATE]!
}
function issue(): string {
  const s = ownership()
  const id = `${s.token}:${++s.next}`
  s.issued.add(id)
  return id
}
function isOwned(el: Element | null): boolean {
  const id = el?.getAttribute(OWNER)
  return !!id && ownership().issued.has(id)
}

interface LuteReaders {
  VditorIRDOM2Md(html: string): string
  VditorDOM2Md(html: string): string
  SpinVditorIRDOM(html: string): string
  SpinVditorDOM(html: string): string
}

function markerTag(marker: Element) {
  return parseHtmlInlineToken(marker.textContent ?? '')
}

function sourceMarkers(root: Element): Element[] {
  return Array.from(root.querySelectorAll('[data-type="html-inline"]')).filter(
    (marker) =>
      !isOwned(marker) &&
      marker.closest(OWNED_SELECTOR) === null &&
      !protectedMarker(marker, root),
  )
}

function protectedMarker(marker: Element, root: Element): boolean {
  for (
    let el = marker.parentElement;
    el && el !== root;
    el = el.parentElement
  ) {
    if (
      el.matches(
        'code,[data-render],[data-type*="code"],[data-type*="math"],pre',
      )
    )
      return true
  }
  return false
}

function pairSubMarkers(
  root: Element,
): Array<{ open: Element; close: Element }> {
  const stack: Array<{ marker: Element; name: string }> = []
  const pairs: Array<{ open: Element; close: Element }> = []
  for (const marker of sourceMarkers(root)) {
    const tag = markerTag(marker)
    if (!tag) return []
    if (tag.void) continue
    if (!tag.closing) {
      stack.push({ marker, name: tag.name })
      continue
    }
    const open = stack.pop()
    if (
      !open ||
      open.name !== tag.name ||
      open.marker.parentElement !== marker.parentElement
    )
      return []
    if (tag.name === 'sub') pairs.push({ open: open.marker, close: marker })
  }
  return stack.length ? [] : pairs
}

function hideMarker(marker: Element, id: string): void {
  ;(marker as HTMLElement).style.display = 'none'
  marker.setAttribute('aria-hidden', 'true')
  marker.setAttribute(OWNER, id)
  marker.setAttribute(MARKER, id)
}

function showMarker(marker: Element): void {
  ;(marker as HTMLElement).style.removeProperty('display')
  marker.removeAttribute('aria-hidden')
  marker.removeAttribute(OWNER)
  marker.removeAttribute(MARKER)
}

export function stripHtmlSubscriptPresentation(html: string): string {
  if (!html.includes(OWNED)) return html
  const template = document.createElement('template')
  template.innerHTML = html
  for (const owned of Array.from(
    template.content.querySelectorAll(OWNED_SELECTOR),
  )) {
    if (!isOwned(owned)) continue
    const id = owned.getAttribute(OWNER)
    const open = owned.previousElementSibling
    const close = owned.nextElementSibling
    if (open?.getAttribute(MARKER) === id) showMarker(open)
    if (close?.getAttribute(MARKER) === id) showMarker(close)
    owned.removeAttribute(OWNER)
    owned.replaceWith(...Array.from(owned.childNodes))
  }
  return template.innerHTML
}

export function wrapHtmlSubscriptLute(lute: LuteReaders): void {
  const owned = lute as LuteReaders & { __vmdeHtmlSubscriptWrapped?: boolean }
  if (owned.__vmdeHtmlSubscriptWrapped) return
  owned.__vmdeHtmlSubscriptWrapped = true
  for (const key of [
    'VditorIRDOM2Md',
    'VditorDOM2Md',
    'SpinVditorIRDOM',
    'SpinVditorDOM',
  ] as const) {
    const original = lute[key].bind(lute)
    lute[key] = (html: string) => original(stripHtmlSubscriptPresentation(html))
  }
}

interface RevealedSubscript {
  container: Element
  bodyText: Text | null
}

function firstBodyText(owned: Element): Text | null {
  const walker = document.createTreeWalker(owned, NodeFilter.SHOW_TEXT)
  return walker.nextNode() as Text | null
}

function reveal(
  owned: Element,
  preferredBody?: Element | null,
): RevealedSubscript | null {
  const open = owned.previousElementSibling
  const close = owned.nextElementSibling
  const container = owned.parentElement
  const id = owned.getAttribute(OWNER)
  if (
    !open ||
    !close ||
    !container ||
    !id ||
    !isOwned(owned) ||
    open.getAttribute(MARKER) !== id ||
    close.getAttribute(MARKER) !== id
  )
    return null
  const bodyText = firstBodyText(preferredBody ?? owned) ?? firstBodyText(owned)
  showMarker(open)
  showMarker(close)
  container.setAttribute(REVEALED, '1')
  owned.removeAttribute(OWNER)
  owned.replaceWith(...Array.from(owned.childNodes))
  return { container, bodyText }
}

function placeCaretInBody(text: Text | null): void {
  if (!text) return
  const range = document.createRange()
  range.setStart(text, Math.min(1, text.data.length))
  range.collapse(true)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function selectionTouches(owned: Element, range: Range): boolean {
  if (
    owned.contains(range.startContainer) ||
    owned.contains(range.endContainer)
  )
    return true
  const probe = range.cloneRange()
  probe.selectNode(owned)
  const start = range.cloneRange()
  start.collapse(true)
  const end = range.cloneRange()
  end.collapse(false)
  const ownedStart = probe.cloneRange()
  ownedStart.collapse(true)
  const ownedEnd = probe.cloneRange()
  ownedEnd.collapse(false)
  return (
    start.compareBoundaryPoints(Range.START_TO_START, ownedEnd) < 0 &&
    end.compareBoundaryPoints(Range.START_TO_START, ownedStart) > 0
  )
}

function hasPresentBody(open: Element, close: Element): boolean {
  for (
    let node = open.nextSibling;
    node && node !== close;
    node = node.nextSibling
  ) {
    if (node instanceof Text) {
      if (node.data.replaceAll('\u200b', '') !== '') return true
      continue
    }
    if (
      node instanceof HTMLElement &&
      (node.tagName === 'WBR' || node.classList.contains('vditor-wbr'))
    )
      continue
    return true
  }
  return false
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: decorates only balanced inline SUB markers while preserving editor DOM ownership
function decorate(root: Element): void {
  for (const container of Array.from(
    root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,td,th,li'),
  )) {
    if (
      container.tagName === 'LI' &&
      container.querySelector(
        ':scope > p,:scope > ul,:scope > ol,:scope > table',
      )
    )
      continue
    if (container.hasAttribute(REVEALED)) continue
    for (const pair of pairSubMarkers(container)) {
      const existing = pair.open.nextElementSibling
      if (
        existing?.matches(OWNED_SELECTOR) &&
        existing.nextElementSibling === pair.close
      ) {
        continue
      }
      // Vditor leaves empty Text/ZWSP/WBR placeholders between marker pairs while it restores an
      // inserted caret. They are not authored body content: presenting them as an empty semantic
      // SUB hides the source markers and moves that caret before the pair.
      if (!hasPresentBody(pair.open, pair.close)) continue
      const id = issue()
      const owned = document.createElement('sub')
      owned.setAttribute(OWNED, '1')
      owned.setAttribute(OWNER, id)
      owned.className = 'vmde-html-subscript'
      let node = pair.open.nextSibling
      while (node && node !== pair.close) {
        const next = node.nextSibling
        owned.append(node)
        node = next
      }
      pair.open.after(owned)
      hideMarker(pair.open, id)
      hideMarker(pair.close, id)
    }
  }
}

/** Reversible inactive-reading presentation for authored `<sub>` marker pairs. */
export function observeHtmlSubscripts(
  root: Element | null | undefined,
): () => void {
  if (!root) return () => undefined
  let applying = false
  const revealed = new Set<Element>()
  const run = () => {
    if (applying || isCompositionActive()) return
    applying = true
    try {
      decorate(root)
    } finally {
      applying = false
    }
  }
  const observer = new MutationObserver(run)
  observer.observe(root, { childList: true, subtree: true })
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: reconciles selected marker bodies and live decoration state
  const onSelection = () => {
    if (isCompositionActive()) return
    const selection = document.getSelection()
    if (!selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    for (const owned of Array.from(root.querySelectorAll(OWNED_SELECTOR))) {
      if (selectionTouches(owned, range)) {
        const result = reveal(owned)
        if (result) revealed.add(result.container)
      }
    }
    for (const container of Array.from(revealed)) {
      const probe = document.createRange()
      probe.selectNodeContents(container)
      const start = range.cloneRange()
      start.collapse(true)
      const end = range.cloneRange()
      end.collapse(false)
      const containerStart = probe.cloneRange()
      containerStart.collapse(true)
      const containerEnd = probe.cloneRange()
      containerEnd.collapse(false)
      if (
        start.compareBoundaryPoints(Range.START_TO_START, containerEnd) < 0 &&
        end.compareBoundaryPoints(Range.START_TO_START, containerStart) > 0
      )
        continue
      container.removeAttribute(REVEALED)
      revealed.delete(container)
      run()
    }
  }
  const onPointer = (event: Event) => {
    if (!(event instanceof MouseEvent)) return
    if (isCompositionActive()) return
    const target =
      event.target instanceof Element
        ? event.target.closest(OWNED_SELECTOR)
        : null
    if (target) {
      const preferred = event.target instanceof Element ? event.target : null
      const result = reveal(target, preferred)
      if (result) {
        // Revealing replaces the semantic wrapper during pointerdown. Put the caret back in the
        // clicked body before the browser resolves its click, so the first edit targets authored
        // SUB content instead of a now-detached wrapper boundary.
        placeCaretInBody(result.bodyText)
        event.preventDefault()
        revealed.add(result.container)
      }
    }
  }
  document.addEventListener('selectionchange', onSelection)
  root.addEventListener('pointerdown', onPointer)
  root.addEventListener('click', onPointer)
  const unsubscribe = subscribeCompositionState((active) => {
    if (!active) run()
  })
  run()
  return () => {
    observer.disconnect()
    document.removeEventListener('selectionchange', onSelection)
    root.removeEventListener('pointerdown', onPointer)
    root.removeEventListener('click', onPointer)
    unsubscribe()
  }
}
