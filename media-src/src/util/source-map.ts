// DOM ↔ markdown-source mapping for the WYSIWYG/IR editor.
//
// Consumed by Reveal-in-Source (task 16) and, later, git gutters (task 17).
// The accurate path uses Lute's own caret token (see getCursorSourceOffset in
// the webview integration); these pure helpers cover line math and the exact
// table-cell mapping, and are unit-tested in isolation.

import { clamp } from '../../../src/shared/clamp'

export const HOIST_HIDDEN_ATTR = 'data-vmde-hoist-hidden'
export const HOIST_OUTLINE_HIDDEN_ATTR = 'data-vmde-hoist-outline-hidden'
export const HOIST_SCOPE_CHANGE_EVENT = 'vmde-section-scope-change'

/** Hidden section blocks remain serializer-owned DOM but are outside the active view. Diagram
 * scanners and viewport/cache gates use this instead of treating DOM presence as visibility. */
export function isSectionHoistHidden(element: Element): boolean {
  return element.closest(`[${HOIST_HIDDEN_ATTR}]`) !== null
}

interface TableCellRef {
  /** index of the table among all tables in the document (0-based) */
  tableIndex: number
  /** DOM row index within the table (0 = header row) */
  row: number
  /** column index within the row (0-based) */
  col: number
}

// Count the newlines before `offset` → the 0-based line number that offset sits
// on. An offset on a '\n' belongs to the line that newline terminates.
export function offsetToLine(md: string, offset: number): number {
  const clamped = clamp(offset, 0, md.length)
  let line = 0
  for (let i = 0; i < clamped; i++) {
    if (md[i] === '\n') line++
  }
  return line
}

// Exact mapping for a table cell: locate the Nth markdown table, then the source
// row (DOM row 0 = header; the separator row is skipped for body rows), then
// count pipes to the target column. Returns the absolute source offset of the
// cell's content start, or null if the table/row can't be located.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: locates a table/row/column in source by counting pipes with escape/code-span guards; pre-existing (task 469 baseline)
export function getTableSourceOffset(
  md: string,
  ref: TableCellRef,
): number | null {
  const lines = md.split('\n')

  // find the start line of the Nth table (a table row starts with '|', and the
  // row that begins a table is one whose previous line is not a table row)
  let tableCount = 0
  let tableStartLine = -1
  for (let i = 0; i < lines.length; i++) {
    const isRow = lines[i].trim().startsWith('|')
    const prevIsRow = i > 0 && lines[i - 1].trim().startsWith('|')
    if (isRow && !prevIsRow) {
      if (tableCount === ref.tableIndex) {
        tableStartLine = i
        break
      }
      tableCount++
    }
  }
  if (tableStartLine < 0) return null

  // DOM row 0 = header (source row 0); DOM body rows skip the separator row,
  // so add 1 for any row beyond the header.
  const sourceRow = tableStartLine + ref.row + (ref.row > 0 ? 1 : 0)
  const line = lines[sourceRow]
  if (line === undefined) return null

  // walk pipes: content of column `col` starts just after the (col+1)-th pipe
  let colPos = 0
  let pipes = 0
  for (let c = 0; c < line.length; c++) {
    if (line[c] === '|') {
      pipes++
      if (pipes > ref.col) {
        colPos = c + 1
        break
      }
    }
  }

  let offset = 0
  for (let i = 0; i < sourceRow; i++) {
    offset += lines[i].length + 1 // +1 for the '\n'
  }
  return offset + colPos
}

const BLOCK_SAMPLE = 25

export interface SourceBlockRange {
  startLine: number
  endLine: number
}

const FENCE_START = /^ {0,3}(`{3,}|~{3,})/
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)\s*$/
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])\s+/
const BLOCKQUOTE = /^ {0,3}>/
const INDENTED = /^(?: {4}|\t)/
const TABLE_DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/

function isTableStart(lines: readonly string[], index: number): boolean {
  return (
    (lines[index]?.includes('|') ?? false) &&
    TABLE_DELIMITER.test(lines[index + 1] ?? '')
  )
}

function fenceEnd(
  lines: readonly string[],
  start: number,
  marker: string,
): number {
  const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`)
  for (let index = start + 1; index < lines.length; index++) {
    if (close.test(lines[index] ?? '')) return index
  }
  return lines.length - 1
}

function startsStructuralBlock(
  lines: readonly string[],
  index: number,
): boolean {
  const line = lines[index] ?? ''
  return Boolean(
    FENCE_START.test(line) ||
      ATX_HEADING.test(line) ||
      THEMATIC_BREAK.test(line) ||
      LIST_ITEM.test(line) ||
      BLOCKQUOTE.test(line) ||
      INDENTED.test(line) ||
      isTableStart(lines, index),
  )
}

function frontMatterEnd(
  lines: readonly string[],
  start: number,
): number | null {
  if (start !== 0 || lines[start]?.trim() !== '---') return null
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.trim() === '---') return index
  }
  return null
}

function fencedBlockEnd(
  lines: readonly string[],
  start: number,
): number | null {
  const marker = FENCE_START.exec(lines[start] ?? '')?.[1]
  return marker ? fenceEnd(lines, start, marker) : null
}

function tableBlockEnd(lines: readonly string[], start: number): number | null {
  if (!isTableStart(lines, start)) return null
  let index = start + 2
  while (
    index < lines.length &&
    (lines[index]?.trim() ?? '') !== '' &&
    (lines[index]?.includes('|') ?? false)
  )
    index++
  return index - 1
}

function quoteBlockEnd(lines: readonly string[], start: number): number | null {
  if (!BLOCKQUOTE.test(lines[start] ?? '')) return null
  let index = start + 1
  while (index < lines.length && BLOCKQUOTE.test(lines[index] ?? '')) index++
  return index - 1
}

function listBlockEnd(lines: readonly string[], start: number): number | null {
  if (!LIST_ITEM.test(lines[start] ?? '')) return null
  let index = start + 1
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') break
    if (!LIST_ITEM.test(line) && !/^ {2,}|^\t/.test(line)) break
    index++
  }
  return index - 1
}

function indentedBlockEnd(
  lines: readonly string[],
  start: number,
): number | null {
  if (!INDENTED.test(lines[start] ?? '')) return null
  let index = start + 1
  while (index < lines.length && INDENTED.test(lines[index] ?? '')) index++
  return index - 1
}

function leafBlockEnd(lines: readonly string[], start: number): number | null {
  return ATX_HEADING.test(lines[start] ?? '') ||
    THEMATIC_BREAK.test(lines[start] ?? '')
    ? start
    : null
}

function setextBlockEnd(
  lines: readonly string[],
  start: number,
): number | null {
  return SETEXT_UNDERLINE.test(lines[start + 1] ?? '') ? start + 1 : null
}

function paragraphBlockEnd(lines: readonly string[], start: number): number {
  let index = start + 1
  while (
    index < lines.length &&
    (lines[index]?.trim() ?? '') !== '' &&
    !startsStructuralBlock(lines, index) &&
    !SETEXT_UNDERLINE.test(lines[index] ?? '')
  )
    index++
  return index - 1
}

function sourceBlockEnd(lines: readonly string[], start: number): number {
  return (
    frontMatterEnd(lines, start) ??
    fencedBlockEnd(lines, start) ??
    tableBlockEnd(lines, start) ??
    quoteBlockEnd(lines, start) ??
    listBlockEnd(lines, start) ??
    indentedBlockEnd(lines, start) ??
    leafBlockEnd(lines, start) ??
    setextBlockEnd(lines, start) ??
    paragraphBlockEnd(lines, start)
  )
}

/** Parse the source into the top-level block order Vditor exposes in IR/WYSIWYG. This is a line
 * ownership scanner, not a Markdown renderer: it keeps multi-line containers together while
 * deliberately leaving blank separator lines unmapped. */
export function markdownBlockRanges(md: string): SourceBlockRange[] {
  const lines = md.split('\n')
  const ranges: SourceBlockRange[] = []
  let index = 0
  while (index < lines.length) {
    if ((lines[index] ?? '').trim() === '') {
      index++
      continue
    }
    const startLine = index
    const endLine = sourceBlockEnd(lines, startLine)
    ranges.push({ startLine, endLine })
    index = endLine + 1
  }
  return ranges
}

export function blockIndexForSourceLine(
  md: string,
  line: number,
): number | null {
  if (!Number.isInteger(line) || line < 0) return null
  const index = markdownBlockRanges(md).findIndex(
    (range) => line >= range.startLine && line <= range.endLine,
  )
  return index < 0 ? null : index
}

/** The block a source-line reveal lands on: the block that owns `line`, else (a blank line between
 * blocks) the next block, else the last block when nothing follows. Null when the document has no
 * block at all. `blockIndexForSourceLine` stays strict (null for a blank line); a link to a blank
 * line still has to land somewhere. */
export function blockIndexForRevealLine(
  md: string,
  line: number,
): number | null {
  const owning = blockIndexForSourceLine(md, line)
  if (owning !== null) return owning
  if (!Number.isInteger(line) || line < 0) return null
  const ranges = markdownBlockRanges(md)
  if (ranges.length === 0) return null
  const next = ranges.findIndex((range) => range.startLine > line)
  return next >= 0 ? next : ranges.length - 1
}

function comparableSourceLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

/** Resolve a host line into the webview's canonical getValue() line space. Vditor may normalize
 * separator blank lines and table padding on load; line text keeps the round-trip anchored. */
export function sourceLineForReveal(
  md: string,
  line: number,
  lineText?: string,
): number | null {
  const lines = md.split('\n')
  if (!Number.isInteger(line) || line < 0) return null
  if (lineText === undefined) return line < lines.length ? line : null
  const wanted = comparableSourceLine(lineText)
  if (line < lines.length && comparableSourceLine(lines[line] ?? '') === wanted)
    return line
  let best: number | null = null
  for (const [index, candidate] of lines.entries()) {
    if (comparableSourceLine(candidate) !== wanted) continue
    if (best === null || Math.abs(index - line) < Math.abs(best - line))
      best = index
  }
  return best
}

function isBlockEl(el: HTMLElement): boolean {
  return /^(P|H[1-6]|BLOCKQUOTE|UL|OL|LI|PRE|TABLE|HR|DIV)$/.test(el.tagName)
}

// Resolve the active mode's editable element (IR / WYSIWYG / SV) — never a
// hard-coded `.vditor-ir`, so mapping works in whatever mode the user is in.
export function activeModeElement(vditor: any): HTMLElement | null {
  const inner = vditor?.vditor
  const mode = inner?.currentMode
  const el = mode ? inner?.[mode]?.element : undefined
  return (el as HTMLElement) || null
}

// The active editable, but ONLY in a BLOCK-DOM mode. ir/wysiwyg render a CHAIN of block elements;
// sv renders the markdown source, and Vditor's setValue wraps the WHOLE document in a single
// `<div data-block="0">` (measured in task 495). Anything reasoning about "the boundary between two
// blocks" — the gap cursor, gap-nav.ts / gap-click.ts — must therefore stand down in sv: that lone
// wrapper reads as ONE atomic block, so the rule would happily splice a paragraph into the source at
// its edges. Not theoretical: wiring the gap cursor to every mode turned four sv/split specs red
// (task 292).
export function blockModeElement(vditor: any): HTMLElement | null {
  const mode = vditor?.vditor?.currentMode
  return mode === 'ir' || mode === 'wysiwyg' ? activeModeElement(vditor) : null
}

function modeDomToMd(vditor: any, html: string): string {
  const lute = vditor?.vditor?.lute
  const mode = vditor?.vditor?.currentMode
  if (!lute) return ''
  if (mode === 'wysiwyg') return lute.VditorDOM2Md(html)
  // ir (and sv falls back to ir conversion well enough for offset purposes)
  return lute.VditorIRDOM2Md(html)
}

// EXACT cursor → source offset, using Lute's own caret token (‸ = Lute.Caret).
// Inserting it as a text node at the selection and round-tripping the active
// mode's innerHTML through Lute's DOM→Md keeps the token in the output even
// inside syntax markers (verified: headings, bold, lists), so indexOf gives the
// precise source offset. Falls back to exact table mapping, then a block-sample
// heuristic, when the token can't be placed/found. Returns -1 if nothing maps.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: caret-to-source-offset resolution across the table/block/heuristic fallback chain; pre-existing (task 469 baseline)
export function getCursorSourceOffset(vditor: any): number {
  const editor = activeModeElement(vditor)
  if (!editor) return -1
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return -1
  const anchorNode = sel.anchorNode
  if (!anchorNode || !editor.contains(anchorNode)) return -1

  const md: string = vditor.getValue()
  const Caret: string = (window as any).Lute?.Caret || '‸'

  // --- table cells: exact mapping computed against the real source ---
  // Tables come first: a Lute caret round-trip re-serializes cell padding /
  // blank lines, so the caret's index in the round-tripped output drifts from
  // the offset in getValue(). getTableSourceOffset counts pipes in the actual
  // markdown, so it stays correct (lands within the right cell/row).
  let cell: HTMLElement | null = null
  let table: HTMLElement | null = null
  let p: Node | null = anchorNode
  while (p && p !== editor) {
    if (p instanceof HTMLElement) {
      if (!cell && (p.tagName === 'TD' || p.tagName === 'TH')) cell = p
      if (p.tagName === 'TABLE') {
        table = p
        break
      }
    }
    p = p.parentNode
  }
  if (table && cell) {
    const tables = Array.from(editor.querySelectorAll('table'))
    const tableIndex = tables.indexOf(table as HTMLTableElement)
    const tr = cell.closest('tr')!
    const row = Array.from(table.querySelectorAll('tr')).indexOf(tr)
    const col = Array.from(tr.querySelectorAll('td, th')).indexOf(cell)
    const off = getTableSourceOffset(md, { tableIndex, row, col })
    if (off !== null) return off
  }

  // --- accurate path (prose/headings/lists): insert the Lute caret token ---
  // For non-table content the round-trip is byte-stable up to the caret, so the
  // caret's index in the output equals the exact source offset — accurate even
  // inside syntax markers (`# `, `**`), which a plain sentinel can't manage.
  const caretNode = document.createTextNode(Caret)
  const range = sel.getRangeAt(0).cloneRange()
  range.collapse(true)
  let inserted = false
  try {
    range.insertNode(caretNode)
    inserted = true
    const out = modeDomToMd(vditor, editor.innerHTML)
    const idx = out.indexOf(Caret)
    if (idx >= 0) return idx
  } catch {
    /* fall through to heuristic */
  } finally {
    if (inserted) {
      caretNode.remove()
      editor.normalize?.()
    }
  }

  // --- fallback: block-sample heuristic (approximate within the block) ---
  let block: HTMLElement | null = null
  let node: Node | null = anchorNode
  while (node && node !== editor) {
    if (node instanceof HTMLElement && isBlockEl(node)) {
      block = node
      break
    }
    node = node.parentNode
  }
  if (!block) return -1
  const blockText = (block.textContent || '').trim()
  const sample = blockText.substring(0, BLOCK_SAMPLE)
  if (!sample) return -1
  const matchIdx = md.indexOf(sample)
  return matchIdx >= 0 ? matchIdx : -1
}

// Resolve a source offset to its 0-based line number and that line's text, both
// in the same string `md`. Reveal-in-source sends BOTH to the host so it can
// match the line by content in the on-disk doc (which may differ from
// vditor.getValue() by Vditor's on-load reflow) instead of trusting a raw
// offset that drifts across the two text spaces.
export function lineAndTextForOffset(
  md: string,
  offset: number,
): { line: number; lineText: string } {
  const clamped = clamp(offset, 0, md.length)
  const lines = md.split('\n')
  const line = md.substring(0, clamped).split('\n').length - 1
  return { line, lineText: lines[line] ?? '' }
}
