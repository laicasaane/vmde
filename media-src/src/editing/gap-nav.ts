// Arrow navigation across VOID boundaries — task 292's mover, the successor to the deleted
// hr-nav.ts (task 100) and to task 496's `gapSlot`. One keydown handler owns the whole class now:
// two handlers pre-empting the same key, each with its own idea of where the caret belongs, is a
// conflict by construction, which is why hr-nav.ts was retired INTO this file, not kept beside it.
//
// The RULE lives in gap-boundary.ts (pure, unit-tested against the matrix); this file is the half
// that needs a real Range and real geometry: is the caret on the block's edge line, and where does
// the caret go. Both writes go through caret.ts's requestCaret (ADR-0007 / task 446).
import { requestCaret } from './caret'
import { boundaryToward, contentBlocks, needsGap } from './gap-boundary'
import { caretLineRect, topLevelBlock } from './nav-geometry'
import { makeGapParagraph } from './trailing-paragraph'
import { guardComposition } from '../util/caret-gesture'
import { innerVditor } from '../util/inner-vditor'
import { isMac } from '../util/platform'
import { writeSelection } from '../util/selection-write'

const isHr = (el: Element | null): el is HTMLHRElement =>
  !!el && el.tagName === 'HR'

// Splice the gap paragraph between `before` and `after` (either may be null at the edges of the
// document) and put the caret in it, after the ZWSP seed so it paints (task 439).
export function placeCaretInGap(
  before: HTMLElement | null,
  after: HTMLElement | null,
): boolean {
  const p = makeGapParagraph()
  if (after) after.insertAdjacentElement('beforebegin', p)
  else if (before) before.insertAdjacentElement('afterend', p)
  else return false // an empty document has no boundary to splice against
  const seed = p.firstChild as Text // makeGapParagraph always seeds one ZWSP text node
  return requestCaret({ node: seed, offset: seed.data.length })
}

// Drop the caret at the start (down) / end (up) of a block's contents. Equivalent to the old
// `range.selectNodeContents(target); range.collapse(down)`.
const placeCaretAtEdge = (target: HTMLElement, down: boolean): boolean =>
  requestCaret({ node: target, offset: down ? 0 : target.childNodes.length })

// Walk the boundaries away from `block` and act on the first one that offers a landing:
//   * a boundary nothing else can reach   → splice a gap paragraph there and stop;
//   * a `<hr>` (void — no text node)      → keep walking, it can never hold the caret;
//   * any other block                     → land at its near edge;
//   * the END of the document, but only after crossing at least one rule → the trailing paragraph
//     (mirrors hr-nav's old fallback; a document simply ENDING in an atomic block is the trailing
//     invariant's own boundary, task 292 — leave it to setupTrailingNav's geometry + keyup net).
// Returns whether the caret was placed (i.e. whether to pre-empt the native move).
// `extend` (Task 714, D3: Shift+Arrow) moves only the selection FOCUS, keeping the anchor, and only
// to a landing that needs no new DOM: a boundary that needs a spliced gap paragraph, or the document
// end, stays native, because a selection key must not edit the document.
function stepAcross(
  editor: HTMLElement,
  block: HTMLElement,
  down: boolean,
  extend = false,
): boolean {
  let cur = block
  let crossedRule = false
  // Bounded by the block count: every hop moves one block in a fixed direction.
  for (;;) {
    const b = boundaryToward(editor, cur, down)
    if (!b) return false
    const landed = landAcross(b, down, crossedRule, extend)
    if (landed !== null) return landed
    cur = (down ? b.after : b.before) as HTMLElement // a rule: keep walking past it
    crossedRule = true
  }
}

// One boundary's verdict: true/false ends the walk (placed / leave it native), null means "the next
// block is a rule, step over it and look at the boundary beyond".
function landAcross(
  b: NonNullable<ReturnType<typeof boundaryToward>>,
  down: boolean,
  crossedRule: boolean,
  extend: boolean,
): boolean | null {
  // The END of the document is the trailing invariant's boundary, never ours — see the note
  // above. Every other gap-needing boundary (including the START of a document whose first block
  // is atomic — the measured hole task 496 left open) gets the paragraph.
  const atDocEnd = down && !b.after
  if (b.needsGap && !atDocEnd) return landInGap(b, extend)
  const next = down ? b.after : b.before
  if (!next) return landAtDocumentEnd(crossedRule && down, extend)
  if (isHr(next)) return null
  // A reachable block, and no void in the way: the NATIVE move gets there by itself — and better
  // than we would, because it keeps the caret's visual column, which placing it at the block's
  // edge would throw away. Only take over once a rule has been crossed (the native move drops the
  // selection ON the void rule — task 100).
  if (!crossedRule) return false
  return extend ? extendFocusToEdge(next, down) : placeCaretAtEdge(next, down)
}

// The two landings that edit the document or the caret authority (gap splice, document end) are
// skipped for a Shift selection (`extend`): the native move stays in charge there.
const landInGap = (
  b: NonNullable<ReturnType<typeof boundaryToward>>,
  extend: boolean,
): boolean => !extend && placeCaretInGap(b.before, b.after)
const landAtDocumentEnd = (eligible: boolean, extend: boolean): boolean =>
  !extend && eligible && requestCaret('document-end')

// Task 714 (D3): the Shift+Arrow twin of placeCaretAtEdge — same landing point, but only the focus
// moves, so the anchor of the running selection stays. A deliberate write through the caret
// authority's marked helper (Task 664); the plain path's requestCaret has no selection-extend form.
function extendFocusToEdge(target: HTMLElement, down: boolean): boolean {
  const sel = window.getSelection()
  if (!sel?.rangeCount || !sel.anchorNode) return false
  return writeSelection({
    anchorNode: sel.anchorNode,
    anchorOffset: sel.anchorOffset,
    focusNode: target,
    focusOffset: down ? 0 : target.childNodes.length,
  })
}

// Plain ArrowUp/Down moves the caret; Shift+ArrowUp/Down (Task 714) extends the selection from the
// same spot. Ctrl, Alt and Meta chords stay with the editor and VS Code.
const isVerticalArrow = (e: KeyboardEvent): boolean =>
  (e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
  !e.ctrlKey &&
  !e.metaKey &&
  !e.altKey

// The block the caret is in, but ONLY when the caret already sits on that block's edge line toward
// the arrow direction — otherwise the native move still has somewhere to travel INSIDE the block
// and pre-empting it would swallow a legitimate line move. Same guard shape as callout-nav.ts and
// gap-paragraph.ts's setupTrailingNav (see nav-geometry.ts's header for why it is repeated rather
// than abstracted).
function edgeBlock(
  editor: HTMLElement,
  down: boolean,
  extend = false,
): HTMLElement | null {
  const sel = window.getSelection()
  if (!sel?.rangeCount) return null
  let r: Range
  if (extend) {
    // Task 714: a Shift selection is judged at its moving end, the focus, not at the anchor.
    if (!sel.focusNode) return null
    r = document.createRange()
    r.setStart(sel.focusNode, sel.focusOffset)
    r.collapse(true)
  } else {
    if (!sel.isCollapsed) return null
    r = sel.getRangeAt(0)
  }
  if (!editor.contains(r.startContainer)) return null
  const block = topLevelBlock(editor, r.startContainer)
  if (!block || isHr(block)) return null
  const cr = caretLineRect(r)
  if (!cr) return null
  const br = block.getBoundingClientRect()
  const tol = Math.max(cr.height * 0.8, 8)
  const onEdge = down ? br.bottom - cr.bottom < tol : cr.top - br.top < tol
  return onEdge ? block : null
}

// The document-start chord: Ctrl+Home, or Cmd+ArrowUp on a Mac. Nothing else — Shift extends a
// selection (the native move is right there), Alt is a different chord.
function isDocumentStartChord(e: KeyboardEvent): boolean {
  if (e.altKey || e.shiftKey) return false
  return isMac()
    ? e.key === 'ArrowUp' && e.metaKey && !e.ctrlKey
    : e.key === 'Home' && e.ctrlKey && !e.metaKey
}

// Task 608 — the document-start move onto an atomic first block. A rule (and a non-editable TOC)
// has no text position, so the native move lands on the bare editable root, where no block marker
// exists for editor-caret.ts to normalise. Same boundary the ArrowUp mover opens (task 292), so
// the caret goes to the boundary-0 gap, which cleanupGapParagraphs reclaims once the caret leaves
// it empty. IR only: the root landing is an IR artefact (WYSIWYG keeps Vditor's own handling).
function openDocumentStart(editor: HTMLElement): boolean {
  if (innerVditor()?.currentMode !== 'ir') return false
  const sel = window.getSelection()
  if (!sel?.rangeCount) return false
  if (!editor.contains(sel.getRangeAt(0).startContainer)) return false
  const first = contentBlocks(editor)[0] ?? null
  if (!first || !needsGap(null, first)) return false
  return placeCaretInGap(null, first)
}

export function setupGapNav(
  getEditor: () => HTMLElement | null | undefined,
): () => void {
  const onKeydown = (e: KeyboardEvent) => {
    if (guardComposition(e)) return
    const editor = getEditor()
    if (!editor) return
    if (isDocumentStartChord(e)) {
      if (openDocumentStart(editor)) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      return
    }
    if (!isVerticalArrow(e)) return
    const extend = e.shiftKey
    const down = e.key === 'ArrowDown'
    const block = edgeBlock(editor, down, extend)
    if (block && stepAcross(editor, block, down, extend)) {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
  }

  document.addEventListener('keydown', onKeydown, true)
  return () => document.removeEventListener('keydown', onKeydown, true)
}
