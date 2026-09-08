import { activeModeElement } from '../util/source-map'
import { innerVditor } from '../util/inner-vditor'
import { isCompositionActive } from '../util/caret-gesture'
import { requestCaret } from './caret'
import {
  checkpointEditorUndo,
  recordRewrapDocumentHistory,
} from './rewrap-command'
import {
  clearTableCellsAt,
  moveTableAt,
  operateTableRectangleAt,
  resolveRenderedTableIndex,
  tableRectangleMarkdownAt,
  type TableMove,
  type TableRectangleOperation,
} from './table-operations'

interface TableActionDeps {
  snapshotExactMarkdown(): string
  setApplying(value: boolean): void
  postExact(markdown: string): void
  onError(error: unknown): void
}

let deps: TableActionDeps | undefined

export function configureTableActions(next: TableActionDeps): void {
  deps = next
}

function activeCell(root: HTMLElement): HTMLTableCellElement | null {
  const node = document.getSelection()?.anchorNode
  const el = node instanceof Element ? node : node?.parentElement
  const cell = el?.closest('td,th')
  return cell instanceof HTMLTableCellElement && root.contains(cell)
    ? cell
    : null
}

function isSourceAddressableTable(table: HTMLTableElement): boolean {
  return (
    !table.querySelector('table,[rowspan],[colspan]') &&
    !table.closest('li,blockquote')
  )
}

function tableIndexFor(root: HTMLElement, table: HTMLTableElement): number {
  if (!isSourceAddressableTable(table)) return -1
  return Array.from(root.querySelectorAll('table'))
    .filter(isSourceAddressableTable)
    .indexOf(table)
}

function sourceAddressableTables(root: HTMLElement): HTMLTableElement[] {
  return Array.from(root.querySelectorAll('table')).filter(
    isSourceAddressableTable,
  )
}

function restoreTableCaret(
  tableIndex: number,
  row: number,
  column: number,
): void {
  const root = window.vditor ? activeModeElement(window.vditor) : null
  const tables = root?.querySelectorAll('table')
  const targetTable = tables?.[Math.min(tableIndex, (tables?.length ?? 1) - 1)]
  const cell =
    targetTable?.rows[Math.min(row, Math.max(0, targetTable.rows.length - 1))]
      ?.cells[
      Math.min(column, Math.max(0, targetTable.rows[0]?.cells.length - 1))
    ]
  if (!root) return
  root?.focus({ preventScroll: true })
  if (cell) requestCaret({ node: cell, offset: 0 })
  else requestCaret('document-end')
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one transaction validates source/DOM identity, generation, undo state, rollback, and caret restoration atomically.
function commitTableTransform(
  table: HTMLTableElement,
  transform: (markdown: string, tableIndex: number) => string | null,
  caret: { row: number; column: number },
): boolean {
  if (!deps || isCompositionActive() || !window.vditor) return false
  const inner = innerVditor()
  const root = activeModeElement(window.vditor)
  if (
    !inner ||
    !root?.contains(table) ||
    (inner.currentMode !== 'ir' && inner.currentMode !== 'wysiwyg')
  ) {
    return false
  }
  const tableIndex = tableIndexFor(root, table)
  if (tableIndex < 0) return false
  const before = deps.snapshotExactMarkdown()
  const renderedBefore = window.vditor.getValue()
  const sourceIndex = resolveRenderedTableIndex(
    before,
    renderedBefore,
    tableIndex,
    sourceAddressableTables(root).length,
  )
  if (sourceIndex === null) return false
  const mode = inner.currentMode
  const after = transform(before, sourceIndex)
  if (after === null || after === before) return false
  // An input/re-render between mapping and commit invalidates the table identity proof. Refuse to
  // overwrite a newer document rather than attempting a best-effort source ordinal.
  if (
    deps.snapshotExactMarkdown() !== before ||
    window.vditor.getValue() !== renderedBefore ||
    inner.currentMode !== mode ||
    activeModeElement(window.vditor) !== root ||
    !root.contains(table)
  ) {
    return false
  }
  deps.setApplying(true)
  try {
    checkpointEditorUndo(inner)
    window.vditor.setValue(after)
    checkpointEditorUndo(inner)
    const native = (inner.undo as any)?.[
      inner.currentMode ?? ''
    ]?.undoStack?.at(-1)
    if (inner.currentMode && native) {
      recordRewrapDocumentHistory({
        owner: inner,
        mode: inner.currentMode,
        nativeState: native,
        beforeRendered: renderedBefore,
        beforeExact: before,
        afterRendered: window.vditor.getValue(),
        afterExact: after,
      })
    }
    restoreTableCaret(sourceIndex, caret.row, caret.column)
    // setValue spins IR/WYSIWYG on its next frame; reapply the logical cell after that spin so a
    // transient pre-spin Range cannot be discarded by Vditor's renderer.
    requestAnimationFrame(() =>
      restoreTableCaret(sourceIndex, caret.row, caret.column),
    )
  } catch {
    // setValue can throw after a partial DOM replacement. The host has not received `after`, so
    // restore the exact pre-transaction source and its closest logical cell before reporting no-op.
    try {
      window.vditor.setValue(before)
      restoreTableCaret(sourceIndex, caret.row, caret.column)
    } catch {
      // A failed rollback still must not post the speculative transform.
    }
    return false
  } finally {
    deps.setApplying(false)
  }
  deps.postExact(after)
  return true
}

/**
 * Runs a source transformation through Vditor's programmatic-history bridge. Deliberately requires
 * an exact rendered snapshot: a failed identity proof is a no-op, never a whole-document rewrite.
 */
export function runTableMove(move: TableMove): boolean {
  try {
    if (!window.vditor) return false
    const inner = innerVditor()
    const root = activeModeElement(window.vditor)
    if (
      !inner ||
      !root ||
      (inner.currentMode !== 'ir' && inner.currentMode !== 'wysiwyg')
    )
      return false
    const cell = activeCell(root)
    const table = cell?.closest('table')
    const row = cell?.parentElement?.closest('tr')
    if (!(table instanceof HTMLTableElement) || !row) return false
    const rowIndex = Array.from(table.rows).indexOf(row)
    const column = Array.from(row.cells).indexOf(cell)
    if (rowIndex < 0 || column < 0) return false
    const next =
      move === 'moveColumnLeft'
        ? { row: rowIndex, column: column - 1 }
        : move === 'moveColumnRight'
          ? { row: rowIndex, column: column + 1 }
          : move === 'moveRowUp'
            ? { row: rowIndex - 1, column }
            : { row: rowIndex + 1, column }
    return commitTableTransform(
      table,
      (markdown, tableIndex) =>
        moveTableAt(markdown, tableIndex, rowIndex, column, move),
      next,
    )
  } catch (error) {
    deps?.onError(error)
    return false
  }
}

/** Commits one rectangle-clear through the same exact-source/history bridge as table moves. */
export function runTableClear(
  table: HTMLTableElement,
  anchorRow: number,
  focusRow: number,
  anchorColumn: number,
  focusColumn: number,
): boolean {
  try {
    return commitTableTransform(
      table,
      (markdown, tableIndex) =>
        clearTableCellsAt(
          markdown,
          tableIndex,
          anchorRow,
          focusRow,
          anchorColumn,
          focusColumn,
        ),
      {
        row: Math.min(anchorRow, focusRow),
        column: Math.min(anchorColumn, focusColumn),
      },
    )
  } catch (error) {
    deps?.onError(error)
    return false
  }
}

/** Returns raw GFM cells for a rectangle; visual text is deliberately not a serialization source. */
export function tableRectangleClipboard(
  table: HTMLTableElement,
  anchorRow: number,
  focusRow: number,
  anchorColumn: number,
  focusColumn: number,
): string | null {
  if (!deps || !window.vditor) return null
  const root = activeModeElement(window.vditor)
  if (!root?.contains(table)) return null
  const tableIndex = tableIndexFor(root, table)
  const sourceIndex = resolveRenderedTableIndex(
    deps.snapshotExactMarkdown(),
    window.vditor.getValue(),
    tableIndex,
    sourceAddressableTables(root).length,
  )
  return sourceIndex === null
    ? null
    : tableRectangleMarkdownAt(
        deps.snapshotExactMarkdown(),
        sourceIndex,
        anchorRow,
        focusRow,
        anchorColumn,
        focusColumn,
      )
}

/** Executes one range-sized structural operation through the exact source transaction bridge. */
export function runTableRectangleOperation(
  table: HTMLTableElement,
  anchorRow: number,
  focusRow: number,
  anchorColumn: number,
  focusColumn: number,
  operation: TableRectangleOperation,
): boolean {
  const caret = {
    row: Math.min(anchorRow, focusRow),
    column: Math.min(anchorColumn, focusColumn),
  }
  return commitTableTransform(
    table,
    (markdown, tableIndex) =>
      operateTableRectangleAt(
        markdown,
        tableIndex,
        anchorRow,
        focusRow,
        anchorColumn,
        focusColumn,
        operation,
      ),
    caret,
  )
}
