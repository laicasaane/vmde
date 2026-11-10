// Task 725 — edit YAML front matter in the properties table (IR and WYSIWYG; D2). A click on a
// name or value cell opens a cell editor in that cell: an `<input>` for a name or a one-line
// value, a small YAML text box for a list, map or multi-line value. Enter or Tab commits (Tab moves
// to the next cell), Esc cancels. "+ Add property" appends `property_<N>: ""` (Task 728 D1-D4), the
// remove button removes a row, and the drag handle or Alt+Up/Alt+Down reorder rows.
//
// Every edit is one exact-source transaction: the lazy edit core (front-matter-edit-model.ts, read
// from `window.__vmdeFrontMatter`) rewrites only the front-matter text of the owned exact bytes,
// and the result goes through `setValue` between two Undo checkpoints, the programmatic-history
// record and the guarded exact post — the table-actions.ts transaction. So each committed cell
// and each structural action is one Undo step, and every other byte of the document is kept.
//
// The cell editor lives inside the table's `data-render="1"` node, so neither Lute serializer ever
// reads it (skill vmde-lute-features). Its events are stopped at the window in the capture phase,
// before any editor or VMDE listener: a keystroke in a cell is never a Vditor input, Undo seed or
// checkpoint. Only the browser's default text editing runs.
import { activeModeElement } from '../util/source-map'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { invalidateCaret, requestCaret } from './caret'
import type { FrontMatterEditOp } from './front-matter-edit-model'
import {
  ADD_CLASS,
  EDIT_CELL_ATTR,
  EDIT_INDEX_ATTR,
  EDIT_TEXT_ATTR,
  EDIT_YAML_ATTR,
  EDITABLE_ATTR,
  installButtonActivation,
  onFrontMatterTableBuilt,
  refreshFrontMatterTables,
} from './front-matter-table'
import {
  checkpointEditorUndo,
  checkpointEditorUndoCoalescing,
  recordRewrapDocumentHistory,
} from './rewrap-command'
import {
  restoreTableUndoForRollback,
  snapshotTableUndoForRollback,
} from './table-actions'
import { disarmAfterRenderUndoEntry } from './undo-boundaries'

export interface FrontMatterEditDeps {
  /** Exact bytes while the webview owns them; `null` otherwise (Task 607). */
  snapshotExactMarkdown(): string | null
  /** Settle typing and pull the host's bytes; `null` when no proof exists (the edit declines). */
  acquireExactAuthority(): Promise<{ exact: string; rendered: string } | null>
  setApplying(value: boolean): void
  postExact(markdown: string, opts?: { rollback?: { restore(): void } }): void
  onError(error: unknown): void
}

type CellKind = 'key' | 'value'
type EditMode = 'ir' | 'wysiwyg'

/** Where focus goes once a transaction has rebuilt the table. */
type FocusTarget =
  | { to: 'editor' | 'cell'; index: number; cell: CellKind }
  | { to: 'add' }
  | { to: 'caret'; caret: SavedCaret | null }
  | { to: 'none' }

interface OpenEditor {
  control: HTMLInputElement | HTMLTextAreaElement
  mode: EditMode
  sig: string
  index: number
  cell: CellKind
  original: string
}

/** A caret in the editor outside the front matter, by top-level block (counted from the end, so
 * a changed front matter does not shift it) and text offset inside that block. */
interface SavedCaret {
  fromEnd: number
  offset: number
}

/** One transaction: a single edit, or several applied in order as one Undo step. */
type EditPlan = FrontMatterEditOp | readonly FrontMatterEditOp[]

interface LazyEdit {
  edit: (markdown: string, op: FrontMatterEditOp) => string | null
  yaml: (markdown: string) => string | null
}

const CONTROL_CLASS = 'vmde-front-matter__editor'
const EDITING_CELL_ATTR = 'data-vmde-fm-editing'
const DRAGGING_ATTR = 'data-vmde-fm-dragging'
const DROP_ATTR = 'data-vmde-fm-drop'
const TABLE_SELECTOR = `.vmde-front-matter[${EDITABLE_ATTR}]`
const ROW_SELECTOR = `tr[${EDIT_INDEX_ATTR}]`
const CELL_SELECTOR = `[${EDIT_CELL_ATTR}]`
const BLOCK_SELECTOR = '[data-type="yaml-front-matter"]'

let deps: FrontMatterEditDeps | undefined
let open: OpenEditor | null = null
let pending: { mode: EditMode; sig: string; focus: FocusTarget } | null = null
/** The caret the document had when focus entered the table; Esc on a cell returns to it. */
let documentCaret: SavedCaret | null = null
/** The cell a transaction just focused; a re-render of the same text right after refocuses it. */
let focusedCell: {
  mode: EditMode
  sig: string
  index: number
  cell: CellKind
  until: number
} | null = null
const REFOCUS_MS = 1500
/** Task 728 D2-D4: the number of the last `property_<N>` that Add wrote in this editor session
 * (this webview, one document); null until the first Add. Undo does not lower it. */
let lastPropertyNumber: number | null = null
/** The native Undo entry each committed transaction left on top, with its rendered text. */
const ownAfterStates = new WeakMap<object, string>()
// Transactions run one at a time: a commit that waits for exact authority finishes before the
// next action plans on the document.
let queue: Promise<unknown> = Promise.resolve()

const lf = (text: string) => text.replace(/\r\n?/g, '\n')

function lazyEdit(): LazyEdit | null {
  const api = (window as unknown as { __vmdeFrontMatter?: Partial<LazyEdit> })
    .__vmdeFrontMatter
  return api?.edit && api.yaml ? (api as LazyEdit) : null
}

function modeOfTable(table: Element): EditMode | null {
  if (table.classList.contains('vditor-ir__preview')) return 'ir'
  if (table.classList.contains('vditor-wysiwyg__preview')) return 'wysiwyg'
  return null
}

function editableTableOf(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element
    ? node.closest<HTMLElement>(TABLE_SELECTOR)
    : null
}

function controlOf(node: EventTarget | null): Element | null {
  return node instanceof Element && node.classList.contains(CONTROL_CLASS)
    ? node
    : null
}

function cellAt(
  table: HTMLElement,
  index: number,
  cell: CellKind,
): HTMLElement | null {
  return table.querySelector<HTMLElement>(
    `${ROW_SELECTOR}[${EDIT_INDEX_ATTR}="${index}"] > [${EDIT_CELL_ATTR}="${cell}"]`,
  )
}

function rowCount(table: HTMLElement): number {
  return table.querySelectorAll(ROW_SELECTOR).length
}

function indexOfCell(cell: Element): number {
  return Number(cell.closest(ROW_SELECTOR)?.getAttribute(EDIT_INDEX_ATTR) ?? -1)
}

/** The live editable table in the active IR/WYSIWYG editor, if there is one. */
function liveTable(mode: EditMode): HTMLElement | null {
  if (!window.vditor) return null
  const root = activeModeElement(window.vditor)
  const table = root?.querySelector<HTMLElement>(TABLE_SELECTOR) ?? null
  return table && modeOfTable(table) === mode ? table : null
}

// --- Caret outside the table --------------------------------------------------------------------

function textPoints(block: Element): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('[data-render]')) out.push(node as Text)
  }
  return out
}

function saveDocumentCaret(): SavedCaret | null {
  const root = window.vditor ? activeModeElement(window.vditor) : null
  const selection = document.getSelection()
  const node = selection?.rangeCount ? selection.anchorNode : null
  if (!root || !node || !root.contains(node) || node === root) return null
  const host = node instanceof Element ? node : node.parentElement
  if (!host || host.closest(BLOCK_SELECTOR)) return null
  const children = [...root.children]
  const block = children.find((child) => child.contains(node))
  if (!block) return null
  let offset = 0
  for (const text of textPoints(block)) {
    if (text === node) {
      offset += selection?.anchorOffset ?? 0
      break
    }
    offset += text.data.length
  }
  return { fromEnd: children.length - 1 - children.indexOf(block), offset }
}

/** Puts the caret back where `saved` was; else at the start of the first block after the table. */
function restoreDocumentCaret(saved: SavedCaret | null): void {
  const root = window.vditor ? activeModeElement(window.vditor) : null
  if (!root) return
  const children = [...root.children]
  const fallback = children.find((child) => !child.matches(BLOCK_SELECTOR))
  const block =
    (saved ? children[children.length - 1 - saved.fromEnd] : undefined) ??
    fallback
  root.focus({ preventScroll: true })
  if (!block) return
  let rest = saved && block !== fallback ? saved.offset : 0
  for (const text of textPoints(block)) {
    if (rest <= text.data.length) {
      requestCaret({ node: text, offset: rest })
      return
    }
    rest -= text.data.length
  }
  requestCaret({ node: block, offset: 0 })
}

// --- Cell editor --------------------------------------------------------------------------------

function closeEditor(): void {
  const current = open
  open = null
  if (!current) return
  const cell = current.control.parentElement
  current.control.remove()
  cell?.removeAttribute(EDITING_CELL_ATTR)
}

function mountControl(
  cellEl: HTMLElement,
  control: OpenEditor['control'],
): void {
  cellEl.setAttribute(EDITING_CELL_ATTR, '')
  cellEl.append(control)
  control.focus({ preventScroll: true })
}

function openEditor(table: HTMLElement, index: number, cell: CellKind): void {
  const mode = modeOfTable(table)
  const cellEl = cellAt(table, index, cell)
  if (!mode || !cellEl) return
  closeEditor()
  const text = cellEl.getAttribute(EDIT_TEXT_ATTR) ?? ''
  const yaml = cell === 'value' && cellEl.hasAttribute(EDIT_YAML_ATTR)
  const control = document.createElement(yaml ? 'textarea' : 'input')
  control.className = CONTROL_CLASS
  if (control instanceof HTMLInputElement) control.type = 'text'
  control.spellcheck = false
  control.value = text
  const name = cellAt(table, index, 'key')?.getAttribute(EDIT_TEXT_ATTR) ?? ''
  control.setAttribute(
    'aria-label',
    cell === 'key'
      ? 'Property name'
      : yaml
        ? `Value of ${name} as YAML (Shift+Enter: new line)`
        : `Value of ${name}`,
  )
  open = {
    control,
    mode,
    sig: table.getAttribute('data-sig') ?? '',
    index,
    cell,
    original: text,
  }
  mountControl(cellEl, control)
  if (yaml) control.setSelectionRange(text.length, text.length)
  else control.select()
}

/** Task 725 D2: Tab order is name → value → next row's name; null past either end. */
function neighbourCell(
  table: HTMLElement,
  index: number,
  cell: CellKind,
  back: boolean,
): { index: number; cell: CellKind } | null {
  const position = index * 2 + (cell === 'value' ? 1 : 0) + (back ? -1 : 1)
  if (position < 0 || position >= rowCount(table) * 2) return null
  return {
    index: Math.floor(position / 2),
    cell: position % 2 === 0 ? 'key' : 'value',
  }
}

function focusAfter(table: HTMLElement, focus: FocusTarget): void {
  if (focus.to === 'none') return
  if (focus.to === 'caret') {
    restoreDocumentCaret(focus.caret)
    return
  }
  if (focus.to === 'add') {
    table.querySelector<HTMLElement>(`.${ADD_CLASS}`)?.focus()
    return
  }
  const last = rowCount(table) - 1
  const index = Math.min(focus.index, last)
  if (index < 0) {
    table.querySelector<HTMLElement>(`.${ADD_CLASS}`)?.focus()
    return
  }
  if (focus.to === 'editor') {
    openEditor(table, index, focus.cell)
    return
  }
  cellAt(table, index, focus.cell)?.focus({ preventScroll: true })
  const mode = modeOfTable(table)
  focusedCell = mode
    ? {
        mode,
        sig: lf(table.getAttribute('data-sig') ?? ''),
        index,
        cell: focus.cell,
        until: Date.now() + REFOCUS_MS,
      }
    : null
}

/** front-matter-table.ts built a new editable table: apply a pending focus or re-mount the editor. */
function onTableBuilt(table: HTMLElement): void {
  const mode = modeOfTable(table)
  const sig = lf(table.getAttribute('data-sig') ?? '')
  if (!mode) return
  if (pending && pending.mode === mode && pending.sig === sig) {
    const { focus } = pending
    pending = null
    focusAfter(table, focus)
    return
  }
  // A re-render of the same text replaced the cell a transaction had just focused: focus the new
  // one, unless the focus has gone somewhere else since.
  if (
    focusedCell &&
    focusedCell.mode === mode &&
    focusedCell.sig === sig &&
    Date.now() < focusedCell.until &&
    (document.activeElement === document.body || !document.activeElement)
  ) {
    cellAt(table, focusedCell.index, focusedCell.cell)?.focus({
      preventScroll: true,
    })
  }
  // The editor's table was replaced by a re-render of the same text (a respin): move the same
  // control, with its text and selection, into the new cell.
  if (open && !open.control.isConnected) {
    if (open.mode !== mode || lf(open.sig) !== sig) {
      open = null
      return
    }
    const cellEl = cellAt(table, open.index, open.cell)
    if (!cellEl) {
      open = null
      return
    }
    const { selectionStart, selectionEnd } = open.control
    mountControl(cellEl, open.control)
    open.control.setSelectionRange(selectionStart, selectionEnd)
  }
}

// --- Transactions -------------------------------------------------------------------------------

function enqueue(run: () => Promise<unknown> | unknown): void {
  queue = queue.then(run).catch((error: unknown) => deps?.onError(error))
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one transaction keeps the identity proof, the history checkpoints, the rollback and the post together, as table-actions.ts does.
function applyEdit(
  mode: EditMode,
  sig: string,
  before: string,
  plan: EditPlan,
  focus: FocusTarget,
): boolean {
  const api = lazyEdit()
  const inner = innerVditor() as InnerVditor | null
  const table = liveTable(mode)
  if (!deps || !api || !inner || inner.currentMode !== mode || !table)
    return false
  // The rows on screen must be the exact text's rows: the op addresses them by index.
  const yamlBefore = api.yaml(before)
  if (
    yamlBefore === null ||
    lf(yamlBefore) !== lf(sig) ||
    lf(table.getAttribute('data-sig') ?? '') !== lf(sig)
  )
    return false
  let after: string | null = before
  for (const op of 'kind' in plan ? [plan] : plan)
    after = after === null ? null : api.edit(after, op)
  if (after === null || after === before) return false
  const yamlAfter = api.yaml(after)
  if (yamlAfter === null) return false
  const renderedBefore = window.vditor.getValue()
  const undoSnapshot = snapshotTableUndoForRollback(inner)
  deps.setApplying(true)
  try {
    // Task 728: one Undo press per transaction. A plain pre-checkpoint pushed a caret-only entry
    // (focus and selection were in the table, the text unchanged) on top of the previous
    // transaction's own entry, so after one Undo the next press only removed that entry and
    // changed nothing (measured in real VS Code, also on the Task 725 build). The coalescing
    // pre-checkpoint (Task 611) rewrites a caret-only difference into the top entry instead; on
    // top of our own entry with the same text the source is proven unchanged.
    const top = (inner.undo as any)?.[mode]?.undoStack?.at(-1)
    checkpointEditorUndoCoalescing(
      inner,
      typeof top === 'object' &&
        top !== null &&
        ownAfterStates.get(top) === renderedBefore,
    )
    pending = { mode, sig: lf(yamlAfter), focus }
    window.vditor.setValue(after)
    checkpointEditorUndo(inner)
    // Task 700 (D13), as details-toggle.ts: `setValue` armed an after-render record that would
    // push this state again once the focus below has moved the caret; one step per edit.
    disarmAfterRenderUndoEntry(inner)
    // Task 609, as details-toggle.ts: the checkpoints restore through the caret authority and arm
    // an intent for the caret from before the rewrite (in the table, so inside the front matter).
    // Left armed, it re-asserts that caret after the focus below: IR then expands the YAML source
    // and the table hides (measured in real VS Code). The focus below supersedes it.
    invalidateCaret()
    const native = (inner.undo as any)?.[mode]?.undoStack?.at(-1)
    if (native) {
      const afterRendered = window.vditor.getValue()
      recordRewrapDocumentHistory({
        owner: inner,
        mode,
        nativeState: native,
        beforeRendered: renderedBefore,
        beforeExact: before,
        afterRendered,
        afterExact: after,
      })
      if (typeof native === 'object') ownAfterStates.set(native, afterRendered)
    }
    // Build the new table now, so the pending focus lands in this task (onTableBuilt).
    refreshFrontMatterTables()
    if (pending) {
      // No table to focus (the last property was removed, or the caret is in the source).
      const { focus: target } = pending
      pending = null
      if (target.to !== 'none') restoreDocumentCaret(documentCaret)
    }
  } catch {
    pending = null
    try {
      window.vditor.setValue(before)
      restoreTableUndoForRollback(inner, undoSnapshot)
    } catch {
      // A failed rollback still must not post the speculative edit.
    }
    return false
  } finally {
    deps.setApplying(false)
  }
  // Task 607 (D2): a host refusal rolls the DOM back to the host text; the Undo stacks are
  // restored here.
  deps.postExact(after, {
    rollback: {
      restore: () => restoreTableUndoForRollback(inner, undoSnapshot),
    },
  })
  return true
}

/** Runs one edit on the exact bytes, acquiring them first when the webview owns none. */
function runEdit(table: HTMLElement, plan: EditPlan, focus: FocusTarget): void {
  const mode = modeOfTable(table)
  const sig = table.getAttribute('data-sig') ?? ''
  if (!mode) return
  enqueue(async () => {
    if (!deps) return
    let before = deps.snapshotExactMarkdown()
    if (before === null)
      before = (await deps.acquireExactAuthority())?.exact ?? null
    if (before !== null && applyEdit(mode, sig, before, plan, focus)) return
    // Declined: focus still goes where the action meant it to, on the table as it is.
    const live = liveTable(mode)
    if (live) focusAfter(live, focus)
  })
}

/** Commits the open editor (nothing when its text is unchanged), then moves focus to `focus`. */
function commitEditor(focus: FocusTarget | null): void {
  const current = open
  if (!current) return
  const table = editableTableOf(current.control)
  const text = current.control.value
  closeEditor()
  if (!table) return
  if (text === current.original) {
    if (focus) focusAfter(table, focus)
    return
  }
  runEdit(
    table,
    { kind: current.cell, index: current.index, text },
    focus ?? { to: 'caret', caret: saveDocumentCaret() },
  )
}

/** Commits an open editor first (its own Undo step), then runs a structural action. */
function structural(
  table: HTMLElement,
  op: (table: HTMLElement) => EditPlan | null,
  focus: FocusTarget,
): void {
  if (open?.control.isConnected) commitEditor({ to: 'none' })
  else open = null
  enqueue(() => {
    const mode = modeOfTable(table)
    const live = mode ? liveTable(mode) : null
    const next = live ? op(live) : null
    if (live && next) runEdit(live, next, focus)
  })
}

function moveRow(
  table: HTMLElement,
  index: number,
  delta: -1 | 1,
  cell: CellKind,
): void {
  const to = index + delta
  if (to < 0 || to >= rowCount(table)) return
  // The focus stays on the moved row: its editor reopens when one was open.
  const reopen = open !== null
  structural(table, () => ({ kind: 'move', index, to }), {
    to: reopen ? 'editor' : 'cell',
    index: to,
    cell,
  })
}

/**
 * Task 728 D2-D4: the name Add writes, `property_<N>`, so the front matter stays valid YAML. The
 * first Add of the editor session starts after the largest `<N>` among the top-level
 * `property_<N>` names of `table` (1 when there is none); each later Add takes the next number. A
 * number whose name is already a top-level key (decoded) is skipped.
 */
function placeholderName(table: HTMLElement): string {
  const used = new Set(
    [...table.querySelectorAll(`[${EDIT_CELL_ATTR}="key"]`)].map((cell) =>
      cell.getAttribute(EDIT_TEXT_ATTR),
    ),
  )
  if (lastPropertyNumber === null) {
    lastPropertyNumber = 0
    for (const key of used) {
      const number = Number(/^property_(\d+)$/.exec(key ?? '')?.[1])
      if (Number.isSafeInteger(number))
        lastPropertyNumber = Math.max(lastPropertyNumber, number)
    }
  }
  let number = lastPropertyNumber + 1
  while (used.has(`property_${number}`)) number++
  lastPropertyNumber = number
  return `property_${number}`
}

// --- Events -------------------------------------------------------------------------------------

/**
 * Task 725 D22: WYSIWYG hides the YAML source while the table shows, and a click on the table now
 * opens a cell editor instead of Vditor's source (showCode), so ArrowUp at the start of the block
 * after the front matter enters the source, as it does natively in IR. The observer then shows the
 * source for the caret inside (front-matter-table.ts `restoreWhileEditing`). Returns whether the
 * key was used.
 */
function enterWysiwygSource(event: KeyboardEvent): boolean {
  if (event.key !== 'ArrowUp' || !isPlain(event) || event.shiftKey) return false
  if (event.isComposing || innerVditor()?.currentMode !== 'wysiwyg')
    return false
  const root = window.vditor ? activeModeElement(window.vditor) : null
  const selection = document.getSelection()
  const node = selection?.isCollapsed ? selection.anchorNode : null
  const block = root?.querySelector<HTMLElement>(
    `:scope > ${BLOCK_SELECTOR}[data-vmde-front-matter="table"]`,
  )
  const next = block?.nextElementSibling
  if (!block || !next || !node || !next.contains(node)) return false
  const before = document.createRange()
  before.setStart(next, 0)
  before.setEnd(node, selection?.anchorOffset ?? 0)
  if (before.toString().replace(/\u200b/g, '') !== '') return false
  const pre = block.querySelector<HTMLElement>(':scope > pre')
  const code = pre?.querySelector('code')
  if (!pre || !code) return false
  pre.style.display = 'block'
  const texts = textPoints(code)
  const last = texts[texts.length - 1]
  requestCaret(
    last
      ? { node: last, offset: last.data.length }
      : { node: code, offset: code.childNodes.length },
  )
  return true
}

function isPlain(event: KeyboardEvent): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey
}

function isAltArrow(event: KeyboardEvent): -1 | 1 | 0 {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return 0
  if (event.key === 'ArrowUp') return -1
  if (event.key === 'ArrowDown') return 1
  return 0
}

function onEditorKey(event: KeyboardEvent): void {
  const current = open
  const table = current ? editableTableOf(current.control) : null
  if (!current || !table || event.isComposing) return
  const move = isAltArrow(event)
  if (move !== 0) {
    event.preventDefault()
    moveRow(table, current.index, move, current.cell)
    return
  }
  if (event.key === 'Enter' && isPlain(event)) {
    // Task 725 D2: Enter commits; in the YAML box Shift+Enter keeps the native line break.
    if (event.shiftKey && current.control instanceof HTMLTextAreaElement) return
    event.preventDefault()
    commitEditor({ to: 'cell', index: current.index, cell: current.cell })
  } else if (event.key === 'Tab' && isPlain(event)) {
    event.preventDefault()
    const next = neighbourCell(
      table,
      current.index,
      current.cell,
      event.shiftKey,
    )
    commitEditor(next ? { to: 'editor', ...next } : { to: 'add' })
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closeEditor()
    cellAt(table, current.index, current.cell)?.focus({ preventScroll: true })
  }
}

const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
}

/** Keys on a focused cell (no editor open). Returns whether the key was ours. */
function onCellKey(event: KeyboardEvent, cell: HTMLElement): boolean {
  const table = editableTableOf(cell)
  const index = indexOfCell(cell)
  const kind = cell.getAttribute(EDIT_CELL_ATTR) as CellKind
  if (!table || index < 0) return false
  const move = isAltArrow(event)
  if (move !== 0) {
    event.preventDefault()
    moveRow(table, index, move, kind)
    return true
  }
  if (!isPlain(event) || event.shiftKey) return false
  if (event.key === 'Enter' || event.key === 'F2') {
    event.preventDefault()
    openEditor(table, index, kind)
    return true
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    restoreDocumentCaret(documentCaret)
    return true
  }
  const arrow = ARROWS[event.key]
  if (arrow) {
    event.preventDefault()
    const column = Math.max(
      0,
      Math.min(1, (kind === 'value' ? 1 : 0) + arrow[1]),
    )
    cellAt(table, index + arrow[0], column === 1 ? 'value' : 'key')?.focus({
      preventScroll: true,
    })
    return true
  }
  return false
}

// Events whose target is a cell editor: stopped before every editor and VMDE listener, defaults
// kept (the browser edits the control's own text).
const ISOLATED = [
  'keydown',
  'keypress',
  'keyup',
  'beforeinput',
  'input',
  'textInput',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'paste',
  'cut',
  'copy',
  'drop',
  'dragover',
  'select',
  'selectionchange',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'pointerdown',
  'pointerup',
  'contextmenu',
  'focusin',
  'focusout',
] as const

/** The index a dragged row lands on: before the first row whose middle is below the pointer. */
function dropIndex(rows: HTMLElement[], from: number, clientY: number): number {
  for (let index = 0; index < rows.length; index++) {
    const box = rows[index].getBoundingClientRect()
    if (clientY < box.top + box.height / 2)
      return index > from ? index - 1 : index
  }
  return rows.length - 1
}

interface Drag {
  table: HTMLElement
  from: number
  to: number
  caret: SavedCaret | null
}

export function installFrontMatterEdit(
  target: Window & typeof globalThis,
  next: FrontMatterEditDeps,
): () => void {
  deps = next
  lastPropertyNumber = null
  const doc = target.document
  let drag: Drag | null = null

  const onIsolated = (event: Event): void => {
    if (!controlOf(event.target)) return
    event.stopImmediatePropagation()
    if (event.type === 'keydown') onEditorKey(event as KeyboardEvent)
    if (event.type === 'focusout') {
      const control = event.target as HTMLElement
      // Decided after the focus has moved: a control removed by a re-render is re-mounted by
      // `onTableBuilt`, and a move inside the table (another cell, a button) commits there.
      target.setTimeout(() => {
        if (open?.control !== control || !control.isConnected) return
        if (doc.activeElement === control) return
        commitEditor(null)
      }, 0)
    }
  }

  // Why: Vditor's keyup and mouseup rules (WYSIWYG's highlightToolbar) read the editor range, which
  // sits in this table while a cell or row button has focus; they opened Vditor's table popover over
  // the table (measured in real VS Code). Keydown still passes for the chords VS Code binds.
  const onTableKeyUp = (event: Event): void => {
    if (!controlOf(event.target) && editableTableOf(event.target))
      event.stopImmediatePropagation()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (controlOf(event.target)) return
    if (enterWysiwygSource(event)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    const cell =
      event.target instanceof HTMLElement && event.target.matches(CELL_SELECTOR)
        ? event.target
        : null
    if (!cell || !editableTableOf(cell)) return
    if (onCellKey(event, cell)) event.stopImmediatePropagation()
  }

  /** The cell a press opens, 'tools' for the drag handle and the remove button's area, null for
   * anything else. */
  const cellOfPointer = (event: MouseEvent): HTMLElement | 'tools' | null => {
    const el = event.target instanceof Element ? event.target : null
    if (!el || el.closest('button') || controlOf(el)) return null
    const cell = el.closest<HTMLElement>(CELL_SELECTOR)
    if (!cell || !editableTableOf(cell)) return null
    return el.closest('.vmde-front-matter__tools, .vmde-front-matter__handle')
      ? 'tools'
      : cell
  }

  // Why: a click on a cell must neither move the editor caret into the block (IR would expand the
  // YAML source and hide the table) nor reach Vditor's click rule on a preview (it opens the
  // source); the cell opens its editor instead.
  const onCellMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || !cellOfPointer(event)) return
    if (!open) documentCaret = saveDocumentCaret() ?? documentCaret
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const onCellClick = (event: MouseEvent): void => {
    const cell = cellOfPointer(event)
    if (!cell) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.button !== 0 || cell === 'tools') return
    const table = editableTableOf(cell) as HTMLElement
    const index = indexOfCell(cell)
    const kind = cell.getAttribute(EDIT_CELL_ATTR) as CellKind
    if (open && open.index === index && open.cell === kind) return
    if (open) {
      commitEditor({ to: 'editor', index, cell: kind })
      return
    }
    openEditor(table, index, kind)
  }

  const onHandleDown = (event: PointerEvent): void => {
    const handle =
      event.target instanceof Element
        ? event.target.closest('.vmde-front-matter__handle')
        : null
    const table = handle ? editableTableOf(handle) : null
    if (!handle || !table || event.button !== 0) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const from = indexOfCell(handle)
    if (from < 0) return
    drag = {
      table,
      from,
      to: from,
      caret: saveDocumentCaret() ?? documentCaret,
    }
    handle.closest(ROW_SELECTOR)?.setAttribute(DRAGGING_ATTR, '')
  }
  const clearDrop = (table: HTMLElement) => {
    for (const row of table.querySelectorAll(`[${DROP_ATTR}]`))
      row.removeAttribute(DROP_ATTR)
  }
  const onDragMove = (event: PointerEvent): void => {
    if (!drag) return
    event.preventDefault()
    const rows = [...drag.table.querySelectorAll<HTMLElement>(ROW_SELECTOR)]
    const to = dropIndex(rows, drag.from, event.clientY)
    drag.to = to
    clearDrop(drag.table)
    if (to !== drag.from)
      rows[to]?.setAttribute(DROP_ATTR, to < drag.from ? 'before' : 'after')
  }
  const endDrag = (commit: boolean): void => {
    const current = drag
    drag = null
    if (!current) return
    clearDrop(current.table)
    for (const row of current.table.querySelectorAll(`[${DRAGGING_ATTR}]`))
      row.removeAttribute(DRAGGING_ATTR)
    if (!commit || current.to === current.from) return
    structural(
      current.table,
      () => ({ kind: 'move', index: current.from, to: current.to }),
      { to: 'caret', caret: current.caret },
    )
  }
  const onDragUp = (event: PointerEvent): void => {
    if (!drag) return
    event.preventDefault()
    event.stopImmediatePropagation()
    // Task 728: the drop row comes from the release point itself, so a release lands on the row
    // under the pointer even when no pointermove reported that row before the release.
    const rows = [...drag.table.querySelectorAll<HTMLElement>(ROW_SELECTOR)]
    if (rows.length) drag.to = dropIndex(rows, drag.from, event.clientY)
    endDrag(true)
  }
  const onDragKey = (event: KeyboardEvent): void => {
    if (drag && event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      endDrag(false)
    }
  }

  for (const type of ISOLATED) target.addEventListener(type, onIsolated, true)
  target.addEventListener('keydown', onDragKey, true)
  target.addEventListener('keydown', onKeyDown, true)
  target.addEventListener('keyup', onTableKeyUp, true)
  target.addEventListener('mouseup', onTableKeyUp, true)
  target.addEventListener('mousedown', onCellMouseDown, true)
  target.addEventListener('click', onCellClick, true)
  target.addEventListener('pointerdown', onHandleDown, true)
  target.addEventListener('pointermove', onDragMove, true)
  target.addEventListener('pointerup', onDragUp, true)

  const disposeAdd = installButtonActivation(doc, `.${ADD_CLASS}`, (button) => {
    const table = editableTableOf(button)
    if (!table) return
    if (!open) documentCaret = saveDocumentCaret() ?? documentCaret
    // Task 728 D1-D4 (replaces Task 725 requirement 4): one transaction appends the line and
    // names it, so the text never holds an empty key; the new last row's name editor opens with
    // the name selected, so typing replaces it. With that editor open and its name unchanged, the
    // next click closes it without a write (D6, `structural`) and adds the next row.
    structural(
      table,
      (live) => [
        { kind: 'append' },
        { kind: 'key', index: rowCount(live), text: placeholderName(live) },
      ],
      { to: 'editor', index: rowCount(table), cell: 'key' },
    )
  })
  const disposeRemove = installButtonActivation(
    doc,
    '.vmde-front-matter__remove',
    (button) => {
      const table = editableTableOf(button)
      const index = indexOfCell(button)
      if (!table || index < 0) return
      const keyboard = doc.activeElement === button
      structural(
        table,
        () => ({ kind: 'remove', index }),
        keyboard
          ? { to: 'cell', index, cell: 'key' }
          : { to: 'caret', caret: saveDocumentCaret() ?? documentCaret },
      )
    },
  )
  onFrontMatterTableBuilt(onTableBuilt)

  return () => {
    for (const type of ISOLATED)
      target.removeEventListener(type, onIsolated, true)
    target.removeEventListener('keydown', onDragKey, true)
    target.removeEventListener('keydown', onKeyDown, true)
    target.removeEventListener('keyup', onTableKeyUp, true)
    target.removeEventListener('mouseup', onTableKeyUp, true)
    target.removeEventListener('mousedown', onCellMouseDown, true)
    target.removeEventListener('click', onCellClick, true)
    target.removeEventListener('pointerdown', onHandleDown, true)
    target.removeEventListener('pointermove', onDragMove, true)
    target.removeEventListener('pointerup', onDragUp, true)
    disposeAdd()
    disposeRemove()
    onFrontMatterTableBuilt(null)
    closeEditor()
    pending = null
    lastPropertyNumber = null
    documentCaret = null
    focusedCell = null
    if (deps === next) deps = undefined
  }
}
