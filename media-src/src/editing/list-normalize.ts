// Task 255 — "Fix list numbering" (caret's list) / "Renormalize all lists" (whole doc).
//
// The renumbering primitive already exists and is proven correct: list-backspace.ts's
// liftTopLevelItemToParagraph replaces a list's outerHTML with
// vditor.lute.SpinVditorIRDOM/SpinVditorDOM(outerHTML) — a round trip through Lute's own
// markdown parser that renumbers ordered lists as a side effect ("Lute normalizes on spin",
// task 284's probe). This module exposes that same "spin one list root, in place" primitive as
// a user-triggered command, scoped to the LIST BLOCK only (never the whole document's DOM) so
// unrelated content stays byte-identical — and shares it with task 281 (sort), which needs the
// identical renumber-after-reorder step ("build it shareable" per that task's scope note).
//
// ir/wysiwyg only: sv's block-scoping story is different (its DOM only gets split into
// per-paragraph `data-block` divs by local edits — a freshly opened document is ONE div for the
// whole source, per vditor/src/index.ts's setValue) and needs its own measurement before it can
// reuse this module's "spin one root" approach; task 255 tracks that as a follow-up.
import { execAfterRender } from 'vditor/src/ts/util/fixBrowserBehavior'
import { setRangeByWbr } from 'vditor/src/ts/util/selection'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import {
  invalidateCaret,
  writeSelection,
  writeSelectionKeepingIntent,
} from './caret'
import { deferUntilSettle } from './edit-activity'
import { checkpointUndoBoundary } from './undo-boundaries'

interface VditorLike {
  currentMode: string
  lute: {
    SpinVditorIRDOM: (html: string) => string
    SpinVditorDOM: (html: string) => string
  }
  [mode: string]: unknown
}

// Whether `list` sits directly inside another list (i.e. it's a NESTED sublist, not a
// top-level root) — its `<ul>/<ol>` is inside an `<li>` that itself belongs to an enclosing
// list within `editor`. Shared by findEnclosingListRoot (climb OUT of nesting) and
// collectListRoots (skip anything that isn't already a top-level root).
function parentListOf(
  list: HTMLElement,
  editor: HTMLElement,
): HTMLElement | null {
  const parentLi = list.parentElement?.closest<HTMLElement>('li') ?? null
  if (!parentLi || !editor.contains(parentLi)) return null
  return parentLi.closest<HTMLElement>('ul, ol')
}

/**
 * Walk from `node` up to the OUTERMOST `<ul>/<ol>` enclosing it — crossing every nested-list
 * boundary — stopping at `editor`. Returns null when `node` isn't inside a list at all. Pure DOM
 * logic (no Lute/undo involvement), so it's unit-testable in jsdom on its own — see
 * list-backspace.test.ts's header for why the DOM-MUTATING half of this family isn't.
 */
export function findEnclosingListRoot(
  node: Node | null,
  editor: HTMLElement,
): HTMLElement | null {
  const start =
    node instanceof HTMLElement ? node : (node?.parentElement ?? null)
  if (!start || !editor.contains(start)) return null
  let root = start.closest<HTMLElement>('ul, ol')
  if (!root || !editor.contains(root)) return null
  for (;;) {
    const outer = parentListOf(root, editor)
    if (!outer) break
    root = outer
  }
  return root
}

// Every TOP-LEVEL list root in `editor` — i.e. every `<ul>/<ol>` that is not itself nested
// inside another list (a blockquote- or table-cell-nested list still counts as top-level here;
// only NESTING UNDER ANOTHER LIST excludes it, since that sublist is rewritten as part of its
// parent root's outerHTML spin). querySelectorAll('ul, ol') rather than a `:scope >` child
// selector — a top-level list can sit inside a blockquote/callout, not just directly in editor.
function collectListRoots(editor: HTMLElement): HTMLElement[] {
  return Array.from(editor.querySelectorAll<HTMLElement>('ul, ol')).filter(
    (list) => !parentListOf(list, editor),
  )
}

function orderedLists(root: HTMLElement): HTMLElement[] {
  const nested = Array.from(root.querySelectorAll<HTMLElement>('ol'))
  return root.tagName === 'OL' ? [root, ...nested] : nested
}

/** Whether any ordered list in this top-level root carries stale direct-child markers. */
export function isListNumberingStale(root: HTMLElement): boolean {
  return orderedLists(root).some((list) => {
    const items = Array.from(list.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.tagName === 'LI',
    )
    const firstMarker =
      list.getAttribute('data-marker') ??
      items[0]?.getAttribute('data-marker') ??
      '1.'
    const start = Number.parseInt(list.getAttribute('start') ?? firstMarker, 10)
    const first = Number.isFinite(start) ? start : 1
    const delimiter = firstMarker.trimEnd().endsWith(')') ? ')' : '.'
    return items.some(
      (item, index) =>
        item.getAttribute('data-marker') !== `${first + index}${delimiter}`,
    )
  })
}

function spinFor(vditor: VditorLike): (html: string) => string {
  return vditor.currentMode === 'wysiwyg'
    ? vditor.lute.SpinVditorDOM.bind(vditor.lute)
    : vditor.lute.SpinVditorIRDOM.bind(vditor.lute)
}

/**
 * Re-serialize ONE list root through Lute, in place — the primitive both commands below use, and
 * that task 281's post-sort renumbering is meant to reuse once it exists (not exported yet: knip
 * flags an export nothing outside this file imports — 281 can re-export the day it actually
 * consumes it). Caller owns caret placement (insert a `<wbr>` into `root` before calling, if a
 * caret needs to survive the swap); this only performs the spin.
 */
function normalizeListRoot(vditor: VditorLike, root: HTMLElement): void {
  const spin = spinFor(vditor)
  root.outerHTML = spin(root.outerHTML)
}

/** Normalize only connected, stale top-level list roots as one caret/undo-preserving edit. */
function normalizeStaleListRoots(
  vditor: VditorLike,
  editor: HTMLElement,
  candidates: Iterable<HTMLElement>,
): number {
  const roots = new Set<HTMLElement>()
  for (const candidate of candidates) {
    if (!candidate.isConnected || !editor.contains(candidate)) continue
    const root = findEnclosingListRoot(candidate, editor)
    if (root) roots.add(root)
  }
  const stale = [...roots].filter(isListNumberingStale)
  if (stale.length === 0) return 0

  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  const caretRoot =
    range && editor.contains(range.startContainer)
      ? findEnclosingListRoot(range.startContainer, editor)
      : null
  const preserveCaret = Boolean(caretRoot && stale.includes(caretRoot) && range)
  if (preserveCaret) range!.insertNode(document.createElement('wbr'))
  const scrollTop = editor.scrollTop
  for (const root of stale) normalizeListRoot(vditor, root)
  if (preserveCaret) setRangeByWbr(editor, range!)
  execAfterRender(vditor as never)
  editor.scrollTop = scrollTop
  return stale.length
}

/**
 * Command "Fix list numbering" — normalize the list enclosing the caret. Returns false
 * (no-op, nothing to undo) when the caret isn't inside a list.
 */
export function fixListNumberingAtCaret(
  vditor: VditorLike,
  editor: HTMLElement,
): boolean {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  if (!editor.contains(range.startContainer)) return false
  const root = findEnclosingListRoot(range.startContainer, editor)
  if (!root) return false
  return normalizeStaleListRoots(vditor, editor, [root]) > 0
}

/**
 * Command "Renormalize all lists" — normalize every top-level list in the document. Returns the
 * number of list roots touched (0 = no-op, nothing to undo). One undo step regardless of how
 * many roots changed: Vditor's undo stack snapshots the whole editor once per execAfterRender()
 * call, not once per DOM mutation, so batching every spin before the single call at the end
 * records exactly one entry.
 */
export function fixAllListNumbering(
  vditor: VditorLike,
  editor: HTMLElement,
): number {
  return normalizeStaleListRoots(vditor, editor, collectListRoots(editor))
}

const AUTO_SETTLE_KEY = 'list-auto-renumber'
const STRUCTURAL_INPUTS = new Set(['deleteByDrag', 'insertFromDrop'])

interface ListContext {
  vditor: InnerVditor
  editor: HTMLElement
}

interface ListAutoRenumberRuntime {
  document: Document
  context(): ListContext | null
  defer(callback: () => void): void
  normalize(
    vditor: InnerVditor,
    editor: HTMLElement,
    roots: Iterable<HTMLElement>,
  ): number
  checkpoint(vditor: InnerVditor): void
}

const defaultAutoRuntime = (): ListAutoRenumberRuntime => ({
  document,
  context: () => {
    const outer = window.vditor
    const vditor = innerVditor()
    const editor = outer ? activeModeElement(outer) : null
    if (
      !vditor ||
      !editor ||
      (vditor.currentMode !== 'ir' && vditor.currentMode !== 'wysiwyg')
    )
      return null
    return { vditor, editor }
  },
  defer: (callback) => deferUntilSettle(AUTO_SETTLE_KEY, callback),
  normalize: (vditor, editor, roots) =>
    normalizeStaleListRoots(vditor as never, editor, roots),
  checkpoint: (vditor) => checkpointUndoBoundary(vditor as never, true),
})

function rootsForSelection(editor: HTMLElement): Set<HTMLElement> {
  const selection = getSelection()
  if (!selection?.rangeCount) return new Set()
  const range = selection.getRangeAt(0)
  const roots = new Set<HTMLElement>()
  for (const node of [range.startContainer, range.endContainer]) {
    const root = findEnclosingListRoot(node, editor)
    if (root) roots.add(root)
  }
  return roots
}

function textOffsetWithin(
  root: HTMLElement,
  node: Node,
  offset: number,
): number {
  const range = document.createRange()
  range.selectNodeContents(root)
  range.setEnd(node, offset)
  return range.toString().length
}

function placeTextOffset(root: HTMLElement, offset: number): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = offset
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (remaining > text.data.length) {
      remaining -= text.data.length
      continue
    }
    const range = document.createRange()
    range.setStart(text, remaining)
    range.collapse(true)
    // Deliberate: restoreDragCaret retired the intent just before and moves the caret to the dropped item.
    writeSelection(range)
    return true
  }
  return false
}

function itemForTarget(target: EventTarget | null): HTMLElement | null {
  if (target instanceof Element) return target.closest<HTMLElement>('li')
  return target instanceof Node
    ? (target.parentElement?.closest<HTMLElement>('li') ?? null)
    : null
}

function structuralBeforeInput(event: InputEvent): boolean {
  return !event.isComposing && STRUCTURAL_INPUTS.has(event.inputType)
}

/** Install structural-edit-only ordered-list normalization for IR/WYSIWYG. */
export function installListAutoRenumber(
  overrides: Partial<ListAutoRenumberRuntime> = {},
): () => void {
  const runtime = { ...defaultAutoRuntime(), ...overrides }
  let pendingEditor: HTMLElement | null = null
  const pendingRoots = new Set<HTMLElement>()
  let dragCaret: { item: HTMLElement; offset: number } | null = null
  let disposed = false

  const capture = (eventTarget?: EventTarget | null) => {
    const context = runtime.context()
    if (!context) return false
    if (pendingEditor && pendingEditor !== context.editor) pendingRoots.clear()
    pendingEditor = context.editor
    for (const root of rootsForSelection(context.editor)) pendingRoots.add(root)
    if (eventTarget instanceof Node) {
      const root = findEnclosingListRoot(eventTarget, context.editor)
      if (root) pendingRoots.add(root)
    }
    return pendingRoots.size > 0
  }

  const restoreDragCaret = (context: ListContext) => {
    if (
      !dragCaret?.item.isConnected ||
      !context.editor.contains(dragCaret.item)
    )
      return
    const movedRoot = findEnclosingListRoot(dragCaret.item, context.editor)
    if (movedRoot) pendingRoots.add(movedRoot)
    invalidateCaret()
    placeTextOffset(dragCaret.item, dragCaret.offset)
  }

  const run = () => {
    if (disposed) return
    const context = runtime.context()
    if (!context || context.editor !== pendingEditor) {
      pendingRoots.clear()
      pendingEditor = null
      return
    }
    restoreDragCaret(context)
    runtime.normalize(context.vditor, context.editor, pendingRoots)
    if (dragCaret) invalidateCaret()
    pendingRoots.clear()
    pendingEditor = null
    dragCaret = null
  }

  const schedule = () => runtime.defer(run)
  const onBeforeInput = (event: Event) => {
    if (!structuralBeforeInput(event as InputEvent)) return
    const context = runtime.context()
    if (context && capture(event.target)) schedule()
  }
  const onDragStart = (event: Event) => {
    const context = runtime.context()
    if (!context || !capture(event.target)) return
    // Dragstart is the final structural gesture boundary after pointer handlers; any caret intent
    // they armed for the source position must not race the browser's drop selection.
    invalidateCaret()
    const selection = runtime.document.getSelection()
    const range = selection?.rangeCount
      ? selection.getRangeAt(0).cloneRange()
      : null
    const item = itemForTarget(event.target)
    dragCaret =
      item && range && item.contains(range.startContainer)
        ? {
            item,
            offset: textOffsetWithin(
              item,
              range.startContainer,
              range.startOffset,
            ),
          }
        : null
    runtime.checkpoint(context.vditor)
    // Vditor's undo snapshot writes its own caret marker. A drag owns the live selection until the
    // browser moves it, so restore the exact pre-snapshot range before native drag handling resumes.
    if (
      range?.startContainer.isConnected &&
      range.endContainer.isConnected &&
      selection
    ) {
      // Transparent: restores the exact pre-snapshot range; the snapshot's own intent stays armed.
      writeSelectionKeepingIntent(range)
    }
  }
  const onDrop = (event: Event) => {
    if (capture(event.target)) schedule()
  }
  runtime.document.addEventListener('beforeinput', onBeforeInput, true)
  runtime.document.addEventListener('dragstart', onDragStart, true)
  runtime.document.addEventListener('drop', onDrop, true)
  return () => {
    disposed = true
    runtime.document.removeEventListener('beforeinput', onBeforeInput, true)
    runtime.document.removeEventListener('dragstart', onDragStart, true)
    runtime.document.removeEventListener('drop', onDrop, true)
    pendingRoots.clear()
    pendingEditor = null
    dragCaret = null
  }
}
