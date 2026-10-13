// Task 636 — wiki page keys can arrive AFTER the editor opens (the host posts `init` without keys
// while its page scan runs, then a `wiki-update`). This module holds the pure/DOM-light pieces the
// webview needs for that gap: restyling chips that already exist (attributes only), and the
// non-insertable "Loading pages…" row of the `[[` hint with its live refresh.

import { normalizeWikiLookupKey } from '../../../src/shared/wiki-core'
import type { WikiHintItem } from './custom-renderer'
import { applyLinkLikeSemantics } from './link-like-semantics'

const LOADING_ATTR = 'data-vmde-wiki-loading'
const LOADING_SELECTOR = `[${LOADING_ATTR}]`

/**
 * Re-evaluate `data-wiki-missing`, `title` and the accessible name of every wiki chip under
 * `root` against `known`. Attributes only: no child, text or class changes, so Vditor's input
 * pipeline, the edit sync (it observes child/character mutations) and the undo stack never see it.
 * Returns the number of chips whose state changed.
 */
export function refreshWikiChips(
  root: ParentNode,
  known: ReadonlySet<string>,
): number {
  let changed = 0
  for (const chip of root.querySelectorAll<HTMLElement>(
    '.wiki-link-chip[data-wiki-target]',
  )) {
    const target = chip.getAttribute('data-wiki-target') ?? ''
    const missing = !known.has(normalizeWikiLookupKey(target))
    if (chip.hasAttribute('data-wiki-missing') === missing) continue
    if (missing) chip.setAttribute('data-wiki-missing', '1')
    else chip.removeAttribute('data-wiki-missing')
    chip.setAttribute(
      'title',
      `${missing ? 'Missing wiki page' : 'Open wiki page'} ${target}`,
    )
    // The role/aria-label ("Open|Missing wiki page …") is derived from data-wiki-missing, and its
    // own observer only watches child lists, so refresh it here.
    applyLinkLikeSemantics(chip)
    changed++
  }
  return changed
}

/** The single hint row shown while page keys are pending. `value` is never inserted (see the guard). */
export function wikiLoadingHintItem(label: string): WikiHintItem {
  const text = label
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  // A wrapper span (not bare text) keeps Vditor's query highlighter, which only rewrites the text
  // after the last `>`, from bolding a typed letter inside the label.
  return { html: `<span ${LOADING_ATTR}="1">${text}</span>`, value: '' }
}

/** The slice of Vditor's internal `Hint` the guard and refresh touch. */
interface HintLike {
  timeId: number
  element: HTMLElement
  select(event: KeyboardEvent, vditor: unknown): boolean
  fillEmoji: (element: HTMLElement, vditor: unknown) => void
  // Private in Vditor's source but plain members at runtime; `rerunWikiLoadingHint` needs them.
  getKey(line: string, extend: HintExtend[]): string | undefined
  splitChar: string
  genHTML(data: WikiHintItem[], key: string, vditor: unknown): void
}

interface HintExtend {
  key: string
  hint?: (query: string) => WikiHintItem[] | Promise<WikiHintItem[]>
}

/** The slice of Vditor's internal instance that owns the hint. */
export interface WikiHintHost {
  hint?: HintLike
  currentMode?: string
  options?: { hint?: { extend?: HintExtend[] } }
  [mode: string]: unknown
}

const isLoadingRow = (button: Element | null): boolean =>
  Boolean(button?.querySelector(LOADING_SELECTOR))

const loadingRowOpen = (hint: HintLike): boolean =>
  hint.element.style.display === 'block' &&
  Boolean(hint.element.querySelector(LOADING_SELECTOR))

function closeHint(hint: HintLike): void {
  clearTimeout(hint.timeId)
  hint.element.style.display = 'none'
}

let removeEscapeListener: (() => void) | undefined

/**
 * Make the loading row non-insertable. Vditor's `Hint` has no notion of a disabled row: `select`
 * (Enter) swallows the key and `fillEmoji` (Enter, click) inserts the row's value. Both are
 * instance members, so they are wrapped per editor instance (re-applied on every init, consumed in
 * vditor-init.ts): Enter on the loading row closes the hint and is NOT consumed, so the editor's
 * normal Enter runs; a click on the row does nothing. Tab already falls through to the editor.
 *
 * Escape needs its own listener: in the IR editor the structural-selection step-out (a document
 * capture listener, selection-scope.ts) consumes Escape before Vditor's bubble handler can close
 * the hint. A window capture listener runs first, closes the loading row and stops the key there.
 * It acts only while the loading row is open, so Escape keeps its other meanings otherwise.
 */
export function guardWikiLoadingRow(host: WikiHintHost | null): void {
  removeEscapeListener?.()
  removeEscapeListener = undefined
  const hint = host?.hint
  if (!hint) return
  const select = hint.select.bind(hint)
  hint.select = (event, vditor) => {
    const current = hint.element.querySelector('.vditor-hint--current')
    if (
      event.key === 'Enter' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.isComposing &&
      loadingRowOpen(hint) &&
      isLoadingRow(current)
    ) {
      closeHint(hint)
      return false
    }
    return select(event, vditor)
  }
  const fill = hint.fillEmoji
  hint.fillEmoji = (element, vditor) => {
    if (isLoadingRow(element)) return
    fill(element, vditor)
  }
  const onEscape = (event: KeyboardEvent) => {
    if (
      event.key !== 'Escape' ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      event.isComposing ||
      !loadingRowOpen(hint)
    )
      return
    closeHint(hint)
    event.preventDefault()
    event.stopPropagation()
  }
  window.addEventListener('keydown', onEscape, true)
  removeEscapeListener = () =>
    window.removeEventListener('keydown', onEscape, true)
}

/**
 * Called when page keys arrive: if the `[[` hint is open on the loading row, run it again with the
 * current query so the matches replace the row in place. This repeats Vditor's `Hint.render` but
 * synchronously (render defers by `hint.delay`, which would leave the loading row on screen for
 * another 200 ms after the keys landed). When the caret is no longer in the editor the row cannot
 * be refreshed, so it is closed instead of left stale.
 */
export function rerunWikiLoadingHint(host: WikiHintHost | null): void {
  const hint = host?.hint
  if (!host || !hint || !loadingRowOpen(hint)) return
  const surface = host.currentMode
    ? (host[host.currentMode] as { element?: HTMLElement } | undefined)?.element
    : undefined
  const selection = window.getSelection()
  const focus = selection?.focusNode
  if (!surface || !focus || !surface.contains(focus) || !selection.rangeCount) {
    closeHint(hint)
    return
  }
  const range = selection.getRangeAt(0)
  const line = (range.startContainer.textContent ?? '').substring(
    0,
    range.startOffset,
  )
  const extend = host.options?.hint?.extend ?? []
  const key = hint.getKey(line, extend)
  const extension = extend.find((item) => item.key === hint.splitChar)
  const items = key === undefined ? undefined : extension?.hint?.(key)
  if (key === undefined || !Array.isArray(items)) {
    closeHint(hint)
    return
  }
  clearTimeout(hint.timeId)
  hint.genHTML(items, key, host)
}
