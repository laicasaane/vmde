import {
  forEachScopeElement,
  onLiveChange,
  forEachRecordScope,
  liveFeedOf,
  writeQuietly,
} from '../util/mutation-impact'

const LINK_LIKE_SELECTOR =
  '[data-wiki-link="1"], [data-code-ref="1"], [data-bare-url="1"]'

function labelWiki(element: HTMLElement): void {
  const target = element.dataset.wikiTarget || element.textContent?.trim() || ''
  const prefix = element.dataset.wikiMissing === '1' ? 'Missing' : 'Open'
  element.setAttribute('role', 'link')
  element.setAttribute('aria-label', `${prefix} wiki page ${target}`)
}

function labelCodeRef(element: HTMLElement): void {
  const path = element.dataset.codeRefPath || element.textContent?.trim() || ''
  const line = element.dataset.codeRefLine
  const column = element.dataset.codeRefCol
  const position = line
    ? `, line ${line}${column ? `, column ${column}` : ''}`
    : ''
  element.setAttribute('role', 'link')
  element.setAttribute('aria-label', `Open code reference ${path}${position}`)
}

function labelBareUrl(element: HTMLElement): void {
  element.setAttribute('role', 'link')
  element.setAttribute(
    'aria-label',
    `Open link ${element.dataset.bareUrlHref || element.textContent?.trim() || ''}`,
  )
}

function labelElement(element: HTMLElement): void {
  if (element.dataset.wikiLink === '1') labelWiki(element)
  else if (element.dataset.codeRef === '1') labelCodeRef(element)
  else if (element.dataset.bareUrl === '1') labelBareUrl(element)
}

export function applyLinkLikeSemantics(root: ParentNode): void {
  // `role` and `aria-label` are view-only: quiet, so the unit-DOM shadow model sees no edit.
  writeQuietly(() => {
    if (root instanceof HTMLElement && root.matches(LINK_LIKE_SELECTOR)) {
      labelElement(root)
    }
    for (const element of root.querySelectorAll<HTMLElement>(
      LINK_LIKE_SELECTOR,
    )) {
      labelElement(element)
    }
  })
}

export function observeLinkLikeSemantics(
  root: HTMLElement | null | undefined,
): () => void {
  if (!root) return () => undefined
  // Task 733: while the feed describes the IR root inside `root`, its unit changes replace the
  // records inside that root.
  const observer = new MutationObserver((records) => {
    const feed = liveFeedOf(root)
    if (!feed) return applyLinkLikeSemantics(root)
    forEachRecordScope(root, records, applyLinkLikeSemantics)
    // Chips a decorator writes inside the feed root are quiet writes: no feed change follows, so
    // the elements these records add are labelled here (O(added nodes), no root walk).
    for (const record of records)
      for (const node of record.addedNodes)
        if (node instanceof HTMLElement && feed.root.contains(node))
          applyLinkLikeSemantics(node)
  })
  observer.observe(root, { childList: true, subtree: true })
  applyLinkLikeSemantics(root)
  const offLive = onLiveChange(root, (change) => {
    if (change.whole) applyLinkLikeSemantics(root)
    else forEachScopeElement(change, applyLinkLikeSemantics)
  })
  return () => {
    observer.disconnect()
    offLive()
  }
}
