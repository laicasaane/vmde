// DOM ↔ markdown-source mapping for the WYSIWYG/IR editor.
//
// Consumed by Reveal-in-Source (task 16) and, later, git gutters (task 17).
// The accurate path uses Lute's own caret token (see getCursorSourceOffset in
// the webview integration); these pure helpers cover line math and the exact
// table-cell mapping, and are unit-tested in isolation.

import { clamp } from '../../../src/shared/clamp'
import {
  unitFeedOf,
  type LiveUnit,
  type UnitFeed,
  type UnitLines,
} from './unit-changes'

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

const FRONT_MATTER_PREVIEW = '.vmde-front-matter'

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

// The candidate line nearest to `line` whose comparable form equals `wanted`, or null.
function nearestLineWith(
  lines: readonly string[],
  line: number,
  wanted: string,
  comparable: (text: string) => string,
): number | null {
  if (line < lines.length && comparable(lines[line] ?? '') === wanted)
    return line
  let best: number | null = null
  for (const [index, candidate] of lines.entries()) {
    if (comparable(candidate) !== wanted) continue
    if (best === null || Math.abs(index - line) < Math.abs(best - line))
      best = index
  }
  return best
}

/** Resolve a host line into the webview's canonical getValue() line space. Vditor may normalize
 * separator blank lines and table padding on load; line text keeps the round-trip anchored.
 * Task 730: when no line has the same text, a line that READS the same (list numbering, table
 * padding and marker spacing ignored, see `readableLineText`) is taken instead. */
export function sourceLineForReveal(
  md: string,
  line: number,
  lineText?: string,
): number | null {
  const lines = md.split('\n')
  if (!Number.isInteger(line) || line < 0) return null
  if (lineText === undefined) return line < lines.length ? line : null
  const exact = nearestLineWith(
    lines,
    line,
    comparableSourceLine(lineText),
    comparableSourceLine,
  )
  if (exact !== null) return exact
  const readable = readableLineText(lineText)
  return readable
    ? nearestLineWith(lines, line, readable, readableLineText)
    : null
}

/** Offset of the first character of 0-based `line` in `md` (clamped to the last line). */
export function lineStartOffset(md: string, line: number): number {
  let offset = 0
  for (let index = 0; index < line; index++) {
    const newline = md.indexOf('\n', offset)
    if (newline < 0) return offset
    offset = newline + 1
  }
  return offset
}

// Task 730 — the text a reader sees for a Markdown source line, so a source line can be found in
// rendered text (Preview) or in an edit block's visible text. Approximate by design: the callers
// align it with the rendered text or search for its start, which both tolerate leftover markup.
const QUOTE_OR_LIST_PREFIX =
  /^\s*(?:>\s?|(?:[-+*]|\d{1,9}[.)])(?:\s+|$)|\[[ xX]\](?:\s+|$)|\[![A-Za-z]+\][-+]?\s*)/u
const HEADING_PREFIX = /^\s*#{1,6}(?:\s+|$)/u
const SYNTAX_ONLY_LINE =
  /^\s*(?:(?:`{3,}|~{3,}).*|\$\$\s*|-{3,}|={3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/u
const INLINE_MARKUP: Array<[RegExp, string]> = [
  [/!\[[^\]]*\]\([^)]*\)/gu, ''], // image: the picture, not its alt text, is what shows
  [/\[\^[^\]]+\]/gu, ''], // footnote reference
  [/\[([^\]]*)\]\([^)]*\)/gu, '$1'], // inline link: its label
  [/\[([^\]]*)\]\[[^\]]*\]/gu, '$1'], // reference link: its label
  [/<((?:https?|mailto):[^>\s]+)>/gu, '$1'], // autolink
  [/<\/?[A-Za-z][^>]*>/gu, ''], // inline HTML tag
  [/(?<!\\)`+/gu, ''], // code span fence
  [/(?<!\\)(?:\*\*|__|~~|==)/gu, ''], // strong, strikethrough, highlight
  [/(?<![\p{L}\p{N}\\])[*_]|(?<!\\)[*_](?![\p{L}\p{N}])/gu, ''], // emphasis, not snake_case
  [/\\([!-/:-@[-`{-~])/gu, '$1'], // backslash escape, last: an escaped marker shows as text
]

/** The readable text of one Markdown source line outside a fence: '' for a line that is syntax
 * only (blank, fence, `$$`, thematic break, setext underline, table delimiter row). */
export function readableLineText(line: string): string {
  if (SYNTAX_ONLY_LINE.test(line) || TABLE_DELIMITER.test(line)) return ''
  let text = line
  for (let previous = ''; previous !== text; ) {
    previous = text
    text = text.replace(QUOTE_OR_LIST_PREFIX, '')
  }
  text = text.replace(HEADING_PREFIX, '').replace(/\s+#+\s*$/u, '')
  if (/^\s*\|/u.test(text)) text = text.replace(/^\s*\|/u, '')
  text = text.replace(/\|\s*$/u, '').replace(/\s+\|\s+/gu, ' ')
  for (const [pattern, replacement] of INLINE_MARKUP)
    text = text.replace(pattern, replacement)
  return comparableSourceLine(text)
}

// One fenced line: the closing fence reads as '' and ends the fence, any other line reads as its
// code. Returns the fence still open after the line.
function readFencedLine(
  line: string,
  fence: string,
  out: string[],
): string | null {
  const closes = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`)
  if (closes.test(line)) {
    out.push('')
    return null
  }
  out.push(line.trim())
  return fence
}

/** `readableLineText` for every line of `md`, keeping fenced code lines verbatim (trimmed) and
 * fence and front-matter delimiters empty. One entry per source line. */
export function readableSourceLines(md: string): string[] {
  const lines = md.split('\n')
  const out: string[] = []
  const frontMatterClose = frontMatterEnd(lines, 0) ?? -1
  let fence: string | null = null
  for (const [index, line] of lines.entries()) {
    if (index <= frontMatterClose) {
      out.push(index === 0 || index === frontMatterClose ? '' : line.trim())
    } else if (fence) {
      fence = readFencedLine(line, fence, out)
    } else {
      fence = FENCE_START.exec(line)?.[1] ?? null
      out.push(fence ? '' : readableLineText(line))
    }
  }
  return out
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
  // The front matter preview is a <table> in the IR DOM but not a table in the Markdown, so it
  // must not count toward the table index (it shifted the target to the next table, and a caret in
  // it has no table row to map).
  if (table && cell && !table.closest(FRONT_MATTER_PREVIEW)) {
    const tables = Array.from(editor.querySelectorAll('table')).filter(
      (candidate) => !candidate.closest(FRONT_MATTER_PREVIEW),
    )
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

// Task 733 / 006: the confirmed line ranges of the feed that describes this IR editor; `undefined`
// sends the caller to the existing path. A reveal read never publishes pending typing, which would
// split an Undo transition (Q-60).
function confirmedUnitLines(
  vditor: any,
  editor: HTMLElement,
): { feed: UnitFeed; lines: readonly UnitLines[] } | undefined {
  if (vditor?.vditor?.currentMode !== 'ir') return undefined
  const feed = unitFeedOf(window)
  if (!feed || feed.root !== editor || !feed.isLive()) return undefined
  const lines = feed.confirmedLines()
  return lines && lines.length > 0 ? { feed, lines } : undefined
}

// Child indices from `root` down to `node`.
function pathFrom(root: Node, node: Node): number[] {
  const path: number[] = []
  for (let cur: Node | null = node; cur && cur !== root; cur = cur.parentNode) {
    const parent: Node | null = cur.parentNode
    if (!parent) break
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, cur))
  }
  return path
}

// Puts the caret token at (`anchor`, `offset`) inside `clone`, a deep copy of the member that holds
// `anchor`; `original` is that member. Only the copy changes.
function placeCaretInClone(
  clone: Node,
  original: Node,
  anchor: Node,
  offset: number,
  caret: string,
): void {
  let target: Node = clone
  for (const index of pathFrom(original, anchor)) {
    target = target.childNodes[index] as Node
  }
  const token = document.createTextNode(caret)
  if (target instanceof Text) {
    const tail = target.splitText(Math.min(offset, target.length))
    tail.before(token)
  } else {
    target.insertBefore(token, target.childNodes[offset] ?? null)
  }
}

// The unit's HTML with the caret token, built from copies (R-1 of the live DOM: never mutated, so
// no observer wakes). A list item goes inside a shallow copy of its list (Q-47).
function unitCaretHtml(
  leaf: LiveUnit,
  anchor: Node,
  offset: number,
  caret: string,
): string {
  const copies = leaf.members.map((member) => {
    const copy = member.cloneNode(true)
    if (member.contains(anchor)) {
      placeCaretInClone(copy, member, anchor, offset, caret)
    }
    return copy as HTMLElement
  })
  if (leaf.kind !== 'list-item' || !leaf.el.parentElement) {
    return copies.map((copy) => copy.outerHTML).join('')
  }
  const shell = leaf.el.parentElement.cloneNode(false) as HTMLElement
  shell.append(...copies)
  return shell.outerHTML
}

// A table row's line: the header is row 0, the delimiter line has no row, body row `k` is
// `k + 2` lines below the table start.
function tableRowLine(cell: HTMLElement): number {
  const row = cell.closest('tr')
  if (!row) return 0
  return row.parentElement?.tagName === 'THEAD' ? 0 : row.sectionRowIndex + 2
}

/** The caret's 0-based line in the host text and, outside tables, that line's text, from the
 * caret's top-level model unit. `undefined` sends the caller to the existing path. */
export function getCursorSourceLine(
  vditor: any,
): { line: number; lineText?: string } | undefined {
  try {
    const editor = activeModeElement(vditor)
    if (!editor) return undefined
    // Confirm first, then read the selection (R-1).
    const confirmed = confirmedUnitLines(vditor, editor)
    if (!confirmed) return undefined
    const sel = window.getSelection()
    const anchor = sel?.anchorNode
    if (!(sel && anchor && editor.contains(anchor))) return undefined
    const leaf = confirmed.feed.liveUnitOf(anchor)
    if (!leaf) return undefined
    const topEl = leaf.kind === 'cell' ? leaf.top : leaf.el
    const entry = confirmed.lines.find((l) => l.el === topEl)
    if (!entry) return undefined
    if (leaf.kind === 'cell') {
      return { line: entry.startLine + tableRowLine(leaf.el) }
    }
    const caret: string = (window as any).Lute?.Caret || '‸'
    const html = unitCaretHtml(leaf, anchor, sel.anchorOffset, caret)
    const md = modeDomToMd(vditor, html).replace(/^\n+/, '')
    const idx = md.indexOf(caret)
    if (idx < 0) return undefined
    const inUnit = md.substring(0, idx).split('\n').length - 1
    const lineText = (md.split('\n')[inUnit] ?? '').replace(caret, '')
    return { line: entry.startLine + inUnit, lineText }
  } catch {
    return undefined
  }
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
