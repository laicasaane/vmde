// Task 458 — outline panel keyboard operability (WCAG 2.1.1 keyboard access). Outline items are
// Vditor's plain, non-focusable `<span data-target-id>`s (measured — zero tabindex anywhere in the
// vendored outline markup); this makes them a real ARIA tree: `role="tree"`/`"treeitem"`/`"group"`,
// roving tabindex (one item tabbable at a time — roving-tabindex.ts, shared with task 456's
// toolbar), ArrowUp/Down to move, ArrowLeft/Right to collapse/expand or step to a parent/child
// (WAI-ARIA APG treeview pattern — a nested tree needs this to be genuinely operable, not just
// "focusable"), and Enter/Space to jump via outline.ts's `scrollToHeadingIndex` (task 243's "ONE
// mechanism, two callers" — message-router's `scroll-to-heading` is the SAME function by index; do
// not add a third path here that re-derives scroll position by hand).
//
// Measured real DOM (chromium harness, `/outline.html`):
//   .vditor-outline > .vditor-outline__title
//                    > .vditor-outline__content > ul
//                        > li > span[data-target-id]  (icon + label; this is the clickable/hoverable
//                                                       row per the vendor's own CSS — `li > span`
//                                                       is what gets `padding`/`cursor:pointer`, the
//                                                       bare `<li>` has none — so this span, not the
//                                                       li, is the treeitem+roving-tabindex target)
//                            > ul                     (nested children, only when the span's next
//                                                       sibling is a <ul> — the vendor's own
//                                                       collapse toggle sets `style.display:none` on
//                                                       exactly this element, never removing it)
//
// Vditor rebuilds `.vditor-outline__content`'s innerHTML wholesale on (essentially) every edit
// (toc.ts, invoked from the ir/wysiwyg input handlers) — same "no JS call site to hook a
// build-time patch onto" situation as code-source.ts (ADR-0004), so re-tagging is a runtime
// MutationObserver, same coalesce-per-frame shape as html-comment.ts's `observePreviewComments`.

import type Vditor from 'vditor'
import { innerVditor } from '../util/inner-vditor'
import { coalescePerFrame } from '../util/observe-coalesce'
import { scrollToHeadingIndex } from './outline'
import {
  focusRovingItem,
  moveRovingFocus,
  setRovingActive,
} from '../util/roving-tabindex'
import { HOIST_OUTLINE_HIDDEN_ATTR } from '../util/source-map'

const ITEM_SELECTOR = 'li > span[data-target-id]'
const TITLE_ID = 'vditor-outline-title'

function items(contentEl: HTMLElement): HTMLElement[] {
  return Array.from(contentEl.querySelectorAll<HTMLElement>(ITEM_SELECTOR))
}

// An item is reachable (by Up/Down, and as an activation target) unless some ancestor <ul> between
// it and the content root is collapsed. The vendor's collapse toggle (outlineRender.ts) sets
// `style.display:none` on the child <ul> sibling of the span it belongs to; it never removes DOM,
// so a hidden branch's spans stay in querySelectorAll and must be skipped here, same as any tree
// widget (a collapsed node's children are not part of the visible traversal order).
function isReachable(item: HTMLElement, contentEl: HTMLElement): boolean {
  if (item.hasAttribute(HOIST_OUTLINE_HIDDEN_ATTR)) return false
  let el: HTMLElement | null = item.parentElement // the <li>
  while (el && el !== contentEl) {
    if (el.tagName === 'UL' && el.style.display === 'none') return false
    el = el.parentElement
  }
  return true
}

function childGroup(item: HTMLElement): HTMLElement | null {
  const next = item.nextElementSibling
  return next instanceof HTMLElement && next.tagName === 'UL' ? next : null
}

function isExpanded(item: HTMLElement): boolean {
  const group = childGroup(item)
  return !!group && group.style.display !== 'none'
}

// Reuses the vendor's OWN collapse mechanism (a synthetic click on its `.vditor-outline__action`
// chevron — outlineRender.ts's bubble-phase listener toggles the `--close` class and the child
// <ul>'s `display`) rather than hand-rolling a second collapse implementation that would have to be
// kept in sync with it.
function toggleExpand(item: HTMLElement): void {
  const action = item.querySelector<HTMLElement>('.vditor-outline__action')
  action?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

// Which flat-index (position among ALL `[data-target-id]` items, matching document heading order —
// the same ordinal `scrollToHeadingIndex` expects) currently holds roving focus. Vditor rebuilds
// `.vditor-outline__content` wholesale, destroying every old element, so this index — not an
// element reference — is what `applyAria` uses to restore the same LOGICAL position (same heading)
// across a rebuild, and only steals focus back if the outline actually had it when the rebuild hit
// (never while the user is typing elsewhere).
let activeIndex = 0

// The recurring "which items count for roving-tabindex purposes" filter — factored out since every
// keyboard handler below needs it (once for the candidate list, once again after moving focus).
function reachableItems(
  all: HTMLElement[],
  contentEl: HTMLElement,
): HTMLElement[] {
  return all.filter((el) => isReachable(el, contentEl))
}

function nearestReachable(
  all: HTMLElement[],
  contentEl: HTMLElement,
  fromIndex: number,
): HTMLElement {
  const exact = all[fromIndex]
  if (exact && isReachable(exact, contentEl)) return exact
  for (let i = fromIndex; i < all.length; i++) {
    if (isReachable(all[i], contentEl)) return all[i]
  }
  return all.find((el) => isReachable(el, contentEl)) ?? all[0]
}

/** Task 729 — native tooltip carrying each entry's full label, because a narrow outline panel cuts
 *  long entries off with an ellipsis. The label is the span's rendered text (the chevron is an
 *  `<svg>` without text), trimmed and whitespace-collapsed. A value is written only when it
 *  differs: Vditor rebuilds the content on every edit and this pass re-runs each time, and the
 *  observer in `installOutlineKeyboard` deliberately does not watch `title`, so a skipped write
 *  also keeps the pass from re-triggering itself. */
export function applyOutlineTitles(all: readonly HTMLElement[]): void {
  for (const item of all) {
    const label = (item.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (item.getAttribute('title') !== label) item.setAttribute('title', label)
  }
}

/** role="tree"/"treeitem"/"group" + roving tabindex + aria-expanded — idempotent, re-applied after
 *  every Vditor outline rebuild. */
function applyAria(contentEl: HTMLElement): void {
  const topUl = contentEl.querySelector(':scope > ul')
  const titleEl = contentEl.previousElementSibling
  if (titleEl instanceof HTMLElement && !titleEl.id) titleEl.id = TITLE_ID
  if (topUl instanceof HTMLElement) {
    topUl.setAttribute('role', 'tree')
    if (titleEl instanceof HTMLElement) {
      topUl.setAttribute('aria-labelledby', titleEl.id || TITLE_ID)
    }
  }
  const all = items(contentEl)
  if (all.length === 0) return
  applyOutlineTitles(all)

  const hadFocus = contentEl.contains(document.activeElement)
  const active = nearestReachable(all, contentEl, activeIndex)
  activeIndex = all.indexOf(active)

  for (const item of all) {
    item.setAttribute('role', 'treeitem')
    // role="none" on the <li> wrapper: without it, the implicit `listitem` role sits between the
    // tree/group and the treeitem in the accessibility tree, breaking the parent-child ownership
    // ARIA trees require.
    item.parentElement?.setAttribute('role', 'none')
    const group = childGroup(item)
    if (group) {
      group.setAttribute('role', 'group')
      item.setAttribute('aria-expanded', String(isExpanded(item)))
    } else {
      item.removeAttribute('aria-expanded')
    }
  }
  setRovingActive(reachableItems(all, contentEl), active)
  if (hadFocus) active.focus({ preventScroll: true })
}

function activate(
  item: HTMLElement,
  contentEl: HTMLElement,
  vditor: Vditor,
): void {
  const index = items(contentEl).indexOf(item)
  if (index >= 0) scrollToHeadingIndex(vditor, index)
}

// focusRovingItem to `target` (already known to be reachable) + keep `activeIndex` pointed at it.
function focusItem(contentEl: HTMLElement, target: HTMLElement): void {
  focusRovingItem(reachableItems(items(contentEl), contentEl), target)
  activeIndex = items(contentEl).indexOf(target)
}

function moveUpDown(contentEl: HTMLElement, direction: 1 | -1): void {
  const next = moveRovingFocus(
    reachableItems(items(contentEl), contentEl),
    direction,
  )
  if (next) activeIndex = items(contentEl).indexOf(next)
}

function arrowRight(contentEl: HTMLElement, item: HTMLElement): void {
  const group = childGroup(item)
  if (!group) return
  if (group.style.display === 'none') {
    // Collapsed: expand in place, stay put (the WAI-ARIA APG treeview pattern — a second
    // ArrowRight, once expanded, is what moves into the first child).
    toggleExpand(item)
    return
  }
  const child = group.querySelector<HTMLElement>(ITEM_SELECTOR)
  if (child) focusItem(contentEl, child)
}

function arrowLeft(contentEl: HTMLElement, item: HTMLElement): void {
  const group = childGroup(item)
  if (group && group.style.display !== 'none') {
    toggleExpand(item) // expanded with children: collapse in place
    return
  }
  // Leaf or already-collapsed: step up to the owning parent item, if any. `item`'s own <li> lives
  // INSIDE the group <ul> (item.parentElement.parentElement), and that group's parent is the <li>
  // that owns it (nested <ul> is a direct child of that <li> — see the DOM shape noted at the top
  // of this file) — three hops from `item`, not two. At the top level that third hop lands on
  // `contentEl` itself (a <div>, not an <li>), which correctly yields "no parent" there.
  const parentLi = item.parentElement?.parentElement?.parentElement
  const parentItem =
    parentLi?.tagName === 'LI'
      ? parentLi.querySelector<HTMLElement>(':scope > span[data-target-id]')
      : null
  if (parentItem) focusItem(contentEl, parentItem)
}

function onKeydown(
  contentEl: HTMLElement,
  vditor: Vditor,
  e: KeyboardEvent,
): void {
  const target = e.target as HTMLElement
  if (!target.matches?.(ITEM_SELECTOR)) return
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      moveUpDown(contentEl, 1)
      return
    case 'ArrowUp':
      e.preventDefault()
      moveUpDown(contentEl, -1)
      return
    case 'ArrowRight':
      e.preventDefault()
      arrowRight(contentEl, target)
      return
    case 'ArrowLeft':
      e.preventDefault()
      arrowLeft(contentEl, target)
      return
    case 'Enter':
    case ' ':
      e.preventDefault()
      activate(target, contentEl, vditor)
      return
    default:
  }
}

/**
 * Install ARIA tree semantics + roving-tabindex keyboard operability on the outline panel.
 * Idempotent across re-inits (disposes the previous instance first). Returns a disposer.
 */
export function installOutlineKeyboard(vditor: Vditor): () => void {
  const outlineEl = innerVditor()?.outline?.element
  const contentEl = outlineEl?.querySelector<HTMLElement>(
    '.vditor-outline__content',
  )
  // Outline panel isn't rendered (empty doc, panel collapsed) — nothing to
  // instrument; hand back a no-op disposer so callers can call it unconditionally.
  if (!outlineEl || !contentEl)
    return () => {
      /* no-op disposer */
    }

  activeIndex = 0
  const run = coalescePerFrame(() => applyAria(contentEl))
  const obs = new MutationObserver(run)
  obs.observe(contentEl, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style'], // mouse-driven collapse/expand also needs a re-assert
  })
  run()

  // Keep `activeIndex` in sync with focus moved by means other than this module's own keyboard
  // handling (e.g. a plain Tab/click landing on an item), so a mid-interaction rebuild restores
  // the right position.
  const onFocusIn = (e: FocusEvent) => {
    const item = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      ITEM_SELECTOR,
    )
    if (item) activeIndex = items(contentEl).indexOf(item)
  }
  contentEl.addEventListener('focusin', onFocusIn)

  const keydownHandler = (e: KeyboardEvent) => onKeydown(contentEl, vditor, e)
  outlineEl.addEventListener('keydown', keydownHandler)

  return () => {
    obs.disconnect()
    run.cancel()
    contentEl.removeEventListener('focusin', onFocusIn)
    outlineEl.removeEventListener('keydown', keydownHandler)
  }
}
