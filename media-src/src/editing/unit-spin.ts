import type { LiveUnit } from '../util/unit-changes'

// Unit spin (Task 733 / 002): a key inside one table cell or one top-level list item re-spins that
// unit alone instead of the whole table or list. Vditor's `ir/input.ts` and the IR paste handler
// call `window.__vmdeSpinUnit` (build patches patchIrUnitSpin and patchPasteUnitSpin) before their
// block spin; a `true` result means the unit is already rewritten and the block spin is skipped.

type UnitSpinRefusal =
  | 'model-off'
  | 'not-a-unit'
  | 'event'
  | 'shape'
  | 'nested'
  | 'disabled'
export type UnitSpinResult =
  | { kind: 'spun'; html: string } // cell: the new innerHTML of the cell; item: the new outerHTML of the li
  | { kind: 'refused'; reason: UnitSpinRefusal }

export interface UnitSpinDeps {
  liveUnitOf(node: Node): LiveUnit | undefined
  spinCell(cellInnerHtml: string): UnitSpinResult
  spinListItem(listShellOpenTag: string, itemOuterHtml: string): UnitSpinResult
  /** The settle re-spin of edit-activity is running (its dispatched input has empty data). */
  isSettleRespin(): boolean
  /** List-item spin is enabled. */
  readonly listItemSpin: boolean
  /** The model is live (a lookup that finds no unit then means "not a unit", not "model off"). */
  isModelLive?(): boolean
  /** End-to-end runs only: count the outcome (reasons and counts, no content). */
  count?(result: 'spun' | UnitSpinRefusal): void
}

const ITEM_ATTRIBUTES = ['class', 'data-marker'] as const
const SPUN = 'spun'
// Refusals report constant strings and return false: a refused call allocates nothing.
const MODEL_OFF: UnitSpinRefusal = 'model-off'
const NOT_A_UNIT: UnitSpinRefusal = 'not-a-unit'
const EVENT: UnitSpinRefusal = 'event'
const SHAPE: UnitSpinRefusal = 'shape'
const NESTED: UnitSpinRefusal = 'nested'
const DISABLED: UnitSpinRefusal = 'disabled'

function refuse(deps: UnitSpinDeps, reason: UnitSpinRefusal): false {
  deps.count?.(reason)
  return false
}

/** One code point, counting a surrogate pair once. */
function isSingleCodePoint(data: string): boolean {
  const first = data.codePointAt(0)
  return first !== undefined && data.length === (first > 0xffff ? 2 : 1)
}

// The selection state before the browser edits, recorded by a capture-phase `beforeinput` listener
// (installUnitSpin). At hook time the deletion has already happened and the selection is collapsed,
// so only this record knows whether a selection spanned units and whether a collapsed caret stood at
// an item start. One preallocated object per window page: the listener writes two booleans and
// allocates nothing. The next hook call reads and clears it.
const before = { multiUnit: false, itemStart: false }

/** The nearest cell or item that holds `node`, or null. */
function unitContainer(node: Node | null): Node | null {
  for (let n = node; n; n = n.parentNode) {
    const tag = (n as Element).tagName
    if (tag === 'TD' || tag === 'TH' || tag === 'LI') return n
  }
  return null
}

/** True when nothing precedes (`node`, `offset`) inside its nearest item. */
function atItemStart(node: Node | null, offset: number): boolean {
  if (offset !== 0) return false
  for (let n = node; n; n = n.parentNode) {
    if ((n as Element).tagName === 'LI') return true
    if (n.previousSibling) return false
  }
  return false
}

function recordBeforeInput(win: Window): void {
  const selection = win.getSelection()
  before.multiUnit = false
  before.itemStart = false
  if (!selection || selection.rangeCount === 0) return
  if (selection.isCollapsed) {
    before.itemStart = atItemStart(selection.anchorNode, selection.anchorOffset)
    return
  }
  // Ends in different cells or items, or one end outside any unit: the unit spin would re-spin one
  // unit and leave the others half edited, so the block spin handles it.
  const start = unitContainer(selection.anchorNode)
  before.multiUnit =
    start === null || start !== unitContainer(selection.focusNode)
}

function itemEventQualifies(
  deps: UnitSpinDeps,
  event: InputEvent | undefined,
  itemStart: boolean,
): boolean {
  if (deps.isSettleRespin()) return true
  if (!event) return false
  if (event.inputType === 'insertText')
    return typeof event.data === 'string' && isSingleCodePoint(event.data)
  if (
    event.inputType === 'deleteContentBackward' ||
    event.inputType === 'deleteContentForward'
  )
    // No `range.collapsed` test: Vditor's input() inserts the caret marker with `range.insertNode`,
    // which widens a collapsed range over the marker. The item-start state comes from the
    // `beforeinput` record: a Backspace at an item start merges it into the previous item (a
    // structural change for the block spin).
    return !itemStart
  return false
}

const isList = (el: Element | null): boolean =>
  el !== null && (el.tagName === 'UL' || el.tagName === 'OL')
const CLOSING_LIST_TAG = /<\/(?:ul|ol)>$/u

/**
 * Writes the spun `li` into the existing element: its inner HTML, `class` and `data-marker`. The
 * element stays, so the model's unit for it stays bound and the observer marks one dirty item. Inner
 * HTML equal to the item's is not written: its nodes stay, and a pending settle re-spin still finds
 * the text node of the keystroke it skipped (a replaced node sends it to the start of the list).
 */
function writeItem(item: HTMLElement, html: string): boolean {
  const holder = item.ownerDocument.createElement('template')
  holder.innerHTML = html
  const next = holder.content.firstElementChild
  if (!next) return false
  const inner = next.innerHTML
  if (inner !== item.innerHTML) item.innerHTML = inner
  for (const name of ITEM_ATTRIBUTES) {
    // Only a changed attribute is written, so an unchanged one adds no mutation record.
    const value = next.getAttribute(name)
    if (value === item.getAttribute(name)) continue
    if (value === null) item.removeAttribute(name)
    else item.setAttribute(name, value)
  }
  return true
}

/** Rule 3: any input event and the settle re-spin qualify; the shape check is the authority. */
function spinCellUnit(
  deps: UnitSpinDeps,
  cell: HTMLElement,
  multiUnit: boolean,
): boolean {
  // A selection over several cells edited text in each of them; only the block spin re-renders them all.
  if (multiUnit) return refuse(deps, EVENT)
  if (!cell.querySelector('wbr')) return refuse(deps, SHAPE)
  const html = cell.innerHTML
  const result = deps.spinCell(html)
  if (result.kind !== 'spun') return refuse(deps, result.reason)
  // An unchanged spin keeps the cell's nodes (see `writeItem`).
  if (result.html !== html) cell.innerHTML = result.html
  deps.count?.(SPUN)
  return true
}

/** Rule 4: typing and deletion of one code point, or the settle re-spin, in an item without nested blocks. */
function spinItemUnit(
  deps: UnitSpinDeps,
  item: HTMLElement,
  event: InputEvent | undefined,
  multiUnit: boolean,
  itemStart: boolean,
): boolean {
  // Q-46: bullet and task items only. An ordered item spun alone is renumbered, so `ol` items keep the block spin.
  if (!deps.listItemSpin || item.parentElement?.tagName !== 'UL')
    return refuse(deps, DISABLED)
  if (item.querySelector('ul, ol, blockquote, pre, table'))
    return refuse(deps, NESTED)
  if (multiUnit || !itemEventQualifies(deps, event, itemStart))
    return refuse(deps, EVENT)
  const list = item.parentElement
  if (!list || !item.querySelector('wbr')) return refuse(deps, SHAPE)
  // The block spin also re-spins an adjacent list before and after (Vditor joins them); the unit spin
  // does not, so adjacent lists keep the block spin.
  if (isList(list.previousElementSibling) || isList(list.nextElementSibling))
    return refuse(deps, SHAPE)
  // The list's own opening tag from a shallow clone: no read of the other items (O(1) in the list size).
  const shell = (list.cloneNode(false) as Element).outerHTML.replace(
    CLOSING_LIST_TAG,
    '',
  )
  const result = deps.spinListItem(shell, item.outerHTML)
  if (result.kind !== 'spun') return refuse(deps, result.reason)
  if (!writeItem(item, result.html)) return refuse(deps, SHAPE)
  deps.count?.(SPUN)
  return true
}

/** The decision and the DOM write; returns true when Vditor's block spin must be skipped. */
export function spinUnit(
  deps: UnitSpinDeps,
  range: Range,
  blockElement: HTMLElement,
  event: InputEvent | undefined,
): boolean {
  // Read and clear the pre-edit record at once, whatever the decision.
  const { multiUnit, itemStart } = before
  before.multiUnit = false
  before.itemStart = false
  // Rule 1: the link-ref-defs widening of upstream made the IR root the block. Every top-level IR
  // block carries `data-block`; the root does not.
  if (!blockElement.hasAttribute('data-block')) return refuse(deps, NOT_A_UNIT)
  // Rule 2: the model is not live.
  const unit = deps.liveUnitOf(range.startContainer)
  if (!unit) return refuse(deps, deps.isModelLive?.() ? NOT_A_UNIT : MODEL_OFF)
  if (unit.top !== blockElement) return refuse(deps, NOT_A_UNIT)
  if (unit.kind === 'cell') return spinCellUnit(deps, unit.el, multiUnit)
  if (unit.kind === 'list-item')
    return spinItemUnit(deps, unit.el, event, multiUnit, itemStart)
  // Rule 5: every other unit keeps Vditor's block spin.
  return refuse(deps, NOT_A_UNIT)
}

type SpinHook = (
  vditor: unknown,
  range: Range,
  blockElement: HTMLElement,
  event: InputEvent | undefined,
) => boolean

/** Installs window.__vmdeSpinUnit(vditor, range, blockElement, event): boolean; returns the uninstall. */
export function installUnitSpin(win: Window, deps: UnitSpinDeps): () => void {
  const slot = win as unknown as { __vmdeSpinUnit?: SpinHook }
  const hook: SpinHook = (_vditor, range, blockElement, event) =>
    spinUnit(deps, range, blockElement, event)
  slot.__vmdeSpinUnit = hook
  const onBeforeInput = (): void => recordBeforeInput(win)
  win.addEventListener('beforeinput', onBeforeInput, true)
  return () => {
    win.removeEventListener('beforeinput', onBeforeInput, true)
    before.multiUnit = false
    before.itemStart = false
    if (slot.__vmdeSpinUnit === hook) delete slot.__vmdeSpinUnit
  }
}
