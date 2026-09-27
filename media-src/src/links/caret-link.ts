// Task 457 — resolve "the link-like thing under the caret", and decorate it.
//
// WHY THIS EXISTS AT ALL, since the obvious answer looks like Tab: it isn't, and that was measured.
// `tab: '\t'` (vditor-init.ts) makes Vditor `preventDefault()` every Tab inside the editable
// surface, so focus can never leave the editing host by Tab — 40 consecutive Tab presses in real
// VS Code never reach a chip. That is not a bug to route around: in an editor **the caret IS the
// focus**. A contenteditable surface is one widget, navigated with the caret, not with Tab, and no
// peer editor makes inline links Tab stops (tabbing through prose to reach the fifth link in a
// paragraph is worse than not reaching it). Obsidian, Typora and Google Docs all activate the link
// *under the cursor* instead — see task 457 for the comparison table.
//
// So the contract is: put the caret in a link, press Ctrl/Cmd+Enter. Two things follow, and both
// live here:
//   1. `linkLikeAt` — which element, if any, the caret is inside. Pure, DOM-node in / element out.
//   2. `CARET_INSIDE_CLASS` — the decoration replacing the focus ring, since with no focusable
//      element `:focus-visible` can never fire. Driven from the live selection, NOT `:focus-within`,
//      which does not work on this surface (task 179 measured that on callouts).
//
// The `tabindex="0"` this task originally shipped on chips is deliberately GONE. It was harmless
// only because Tab never reached it; if Tab is ever freed it would become mid-paragraph Tab stops,
// which is actively worse than the gap it was meant to close.

// Every shape a "link" takes in this editor. Kept as one selector so the activation path, the
// decoration and the tests cannot drift apart — chips are rendered by THREE separate templates
// (custom-renderer.ts's `wikiTextToHtml`, wiki-serialize.ts's `reintroduceChips`, vditor-init.ts's
// `[[` autocomplete) that share no markup, so a per-call-site selector would rot silently.
const LINK_LIKE_SELECTOR =
  '[data-wiki-link="1"],[data-code-ref="1"],a[href],.vditor-ir__link'

// Task 578: a presentation class keeps caret movement source-neutral under the
// shared index's existing class filter. Vditor rebuilds drop it; selectionchange
// restores it without replacing the link's other classes. main.css paints the ring.
export const CARET_INSIDE_CLASS = 'vmde-caret-inside'

// The link-like element containing `node`, or null. Text nodes are the normal case — a caret in
// prose anchors to a text node — so start from the parent element for those.
export function linkLikeAt(node: Node | null): HTMLElement | null {
  if (!node) return null
  const start =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return start?.closest<HTMLElement>(LINK_LIKE_SELECTOR) ?? null
}

// The link-like element the given selection sits in. Only a COLLAPSED selection counts: a caret,
// not a range. Dragging a selection across a link is not "targeting" it — the user is selecting
// text, and activating on Ctrl+Enter there would fight ordinary editing.
export function linkLikeInSelection(
  selection: { anchorNode: Node | null; isCollapsed: boolean } | null,
): HTMLElement | null {
  if (!selection?.isCollapsed) return null
  return linkLikeAt(selection.anchorNode)
}

// Move the decoration to `next` (or clear it), returning whether anything changed. Idempotent by
// construction so the selectionchange listener can call it on every event without touching the DOM
// when the caret merely moved within the same link.
export function applyCaretInside(
  root: ParentNode | null,
  next: HTMLElement | null,
): boolean {
  if (!root) return false
  let changed = false
  for (const el of root.querySelectorAll<HTMLElement>(
    `.${CARET_INSIDE_CLASS}`,
  )) {
    if (el !== next) {
      el.classList.remove(CARET_INSIDE_CLASS)
      changed = true
    }
  }
  if (next && !next.classList.contains(CARET_INSIDE_CLASS)) {
    next.classList.add(CARET_INSIDE_CLASS)
    changed = true
  }
  return changed
}
