// Task 457 — DOM wiring for caret-link.ts's pure core: paint `vmde-caret-inside` on whatever
// link-like element the caret currently sits in, from the live selection. Kept out of
// caret-link.ts on purpose — that module is pure (DOM node in / element out, no globals, no
// listeners) so its 18 unit tests don't need jsdom's selection APIs; this file is the thin
// DOM-observer half, same split as callouts.ts (matchCallout, pure) vs observeCallouts (wiring).
//
// `selectionchange`, not `:focus-within` — task 179 measured `:focus-within` doesn't fire on this
// surface (contenteditable selection changes don't reliably toggle it), which is why callouts.ts
// already made the same call for its own caret-in-source decoration. Coalesced per animation frame
// (same coalescePerFrame callouts.ts uses) since selectionchange fires on every caret move,
// including every keystroke while typing prose.
import { coalescePerFrame } from '../util/observe-coalesce'
import { applyCaretInside, linkLikeInSelection } from './caret-link'

/**
 * Keep `.vmde-caret-inside` in sync with the live selection for every link-like element under
 * `root`. Returns a disposer. Bind to the stable `#app` mount (survives IR/WYSIWYG mode switches
 * — same rationale as observeCallouts), never to the read-only Preview pane: Preview has no caret,
 * so there is nothing for this decoration to track there.
 */
export function observeCaretLink(
  root: HTMLElement | null | undefined,
): () => void {
  // No editor root mounted yet — nothing to observe; hand back a no-op
  // disposer so callers can always call the returned teardown unconditionally.
  if (!root)
    return () => {
      /* no-op disposer */
    }
  const doc = root.ownerDocument
  const run = coalescePerFrame(() => {
    const sel = doc.getSelection?.()
    const anchor = sel?.rangeCount ? sel.anchorNode : null
    // Selectionchange is document-wide, but `applyCaretInside` trusts its `next` argument without
    // checking containment — so without this guard, a caret that lands in some OTHER editable
    // surface on the page (there is none today, but nothing enforces that invariant) could still
    // get decorated as if it were inside `root`.
    const inRoot = !!anchor && root.contains(anchor)
    applyCaretInside(root, inRoot ? linkLikeInSelection(sel) : null)
  })
  doc.addEventListener('selectionchange', run)
  run()
  return () => {
    doc.removeEventListener('selectionchange', run)
    run.cancel()
  }
}
