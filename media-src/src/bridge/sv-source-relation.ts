// Task 675 — the Source-mode relation between the host's exact text and the text Source mode shows.
//
// Source mode shows the host text itself, except where Lute or Vditor change it: a switch from IR or
// WYSIWYG shows Lute's serialization (table padding and delimiter dashes), and a direct open shows
// ordered lists renumbered sequentially and one more trailing line break. A plain equality proof
// refuses all of these, so every exact Source action declined (Task 669). This relation accepts only
// those measured differences and refuses everything else, so a stale host text or an unrelated
// difference still fails closed. The Source commands re-prove their own region after acquisition.
//
// Limit: bytes the user typed inside an accepted class (Enter at the end of the text, a typed list
// number, typed table padding) cannot be told apart from what Lute or Vditor changed. Safety does
// not rest on this relation alone: EditSync settles pending typing before it asks the host for its
// text (`settleExactInput` in `acquireExactAuthority`), and `receiveExactAuthority` also requires
// the rendering and the trusted-input count to be unchanged since the request.

const normalizeEol = (text: string): string => text.replace(/\r\n?/g, '\n')

const FENCE = /^ {0,3}(`{3,}|~{3,})/u
const LIST_ITEM = /^( *)(\d{1,9})([.)])( .*)?$/u
const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/u
const DELIMITER_CELL = /^:?-+:?$/u
const MATH_FENCE = /^ {0,3}\$\$\s*$/u
const OTHER_BLOCK = /^\s*(>|#|[-*+]\s|\d{1,9}[.)]\s|`{3}|~{3})/u
const HTML_START = /^ {0,3}<[A-Za-z!/?]/u
const RAW_HTML_TAG = /^ {0,3}<(pre|script|style|textarea)[\s>]/iu

type TableRole = 'header' | 'delimiter' | 'body'

// Marks the lines of GFM table blocks outside fenced and HTML blocks: a run of consecutive lines that
// all contain a pipe, none of which starts another block (quote, heading, list item, fence), and
// whose second line is a delimiter row with as many cells as the first line. Every other line has no
// role.
function tableRoles(
  lines: string[],
  opaque: boolean[],
): Array<TableRole | null> {
  const roles: Array<TableRole | null> = lines.map(() => null)
  let start = 0
  while (start < lines.length) {
    let end = start
    while (
      end < lines.length &&
      !opaque[end] &&
      lines[end].includes('|') &&
      !OTHER_BLOCK.test(lines[end])
    )
      end++
    if (
      end - start >= 2 &&
      DELIMITER_ROW.test(lines[start + 1]) &&
      rowCells(lines[start]).length === rowCells(lines[start + 1]).length
    ) {
      roles[start] = 'header'
      roles[start + 1] = 'delimiter'
      for (let i = start + 2; i < end; i++) roles[i] = 'body'
    }
    start = Math.max(end, start + 1)
  }
  return roles
}

// The fence marker a line carries (a backtick or tilde run, or `$$` for math), or null.
function fenceMarker(line: string): string | null {
  return MATH_FENCE.test(line) ? '$$' : (FENCE.exec(line)?.[1] ?? null)
}

// Whether `line` closes the block that `open` opened.
function closesFence(open: string, line: string): boolean {
  const marker = fenceMarker(line)
  if (marker === null || marker[0] !== open[0]) return false
  return (
    open === '$$' || (marker.length >= open.length && line.trim() === marker)
  )
}

// Whether each line sits inside (or on the fence lines of) a fenced code block or a `$$` math block.
function fenceMap(lines: string[]): boolean[] {
  const inFence: boolean[] = []
  let open: string | null = null
  for (const line of lines) {
    if (open === null) {
      open = fenceMarker(line)
      inFence.push(open !== null)
    } else {
      inFence.push(true)
      if (closesFence(open, line)) open = null
    }
  }
  return inFence
}

// Whether each line sits inside an HTML block: from a line that starts with a tag up to the next
// blank line, or for `pre`, `script`, `style` and `textarea` through the line with the closing tag.
function htmlMap(lines: string[], inFence: boolean[]): boolean[] {
  const inHtml: boolean[] = []
  let closing: RegExp | null = null
  let open = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!open && !inFence[i] && HTML_START.test(line)) {
      open = true
      const raw = RAW_HTML_TAG.exec(line)?.[1]
      closing = raw ? new RegExp(`</${raw}>`, 'iu') : null
    }
    inHtml.push(open)
    if (open && (closing ? closing.test(line) : line.trim() === ''))
      open = false
  }
  return inHtml
}

// The cells of a table row: outer pipes removed, split on unescaped pipes, trimmed.
function rowCells(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) {
      current += text[i] + text[i + 1]
      i++
    } else if (text[i] === '|') {
      cells.push(current.trim())
      current = ''
    } else current += text[i]
  }
  if (current.trim() !== '' || !line.trim().endsWith('|'))
    cells.push(current.trim())
  return cells
}

const alignmentOf = (cell: string): string | null =>
  DELIMITER_CELL.test(cell)
    ? `${cell.startsWith(':') ? 'l' : ''}${cell.endsWith(':') ? 'r' : ''}`
    : null

// Two rows of the same table role that differ only in padding (and, for delimiter rows, dash count).
function sameTableRow(host: string, shown: string, role: TableRole): boolean {
  const a = rowCells(host)
  const b = rowCells(shown)
  if (a.length !== b.length) return false
  return a.every((cell, index) => {
    if (role !== 'delimiter') return cell === b[index]
    const left = alignmentOf(cell)
    return left !== null && left === alignmentOf(b[index])
  })
}

interface ListState {
  // The last ordered number and delimiter shown at each indent of the list being read.
  open: Map<number, { delimiter: string; number: number }>
}

// Updates the ordered-list state with one shown line and returns the number Vditor must show for an
// item that continues a list, or null for a first item and for a line that is not an ordered item.
// `afterText` tells that the previous line is paragraph text: a list can interrupt a paragraph only
// when it starts with 1, so any other item there is text.
function continuedNumber(
  state: ListState,
  line: string,
  afterText: boolean,
): number | null {
  if (line.trim() === '') return null
  const indent = line.length - line.trimStart().length
  let item = LIST_ITEM.exec(line)
  const previous = item ? state.open.get(indent) : undefined
  if (item && afterText && previous === undefined && Number(item[2]) !== 1)
    item = null
  for (const key of [...state.open.keys()])
    if (key > indent || (key === indent && !item)) state.open.delete(key)
  if (!item) return null
  const continues = previous?.delimiter === item[3]
  state.open.set(indent, { delimiter: item[3], number: Number(item[2]) })
  return continues ? previous.number + 1 : null
}

// An ordered item whose number Vditor renumbered: same indent, delimiter and text, and the shown
// number follows the previous shown number of the same list.
function renumberedItem(
  host: string,
  shown: string,
  expected: number | null,
): boolean {
  const a = LIST_ITEM.exec(host)
  const b = LIST_ITEM.exec(shown)
  return (
    a !== null &&
    b !== null &&
    expected !== null &&
    a[1] === b[1] &&
    a[3] === b[3] &&
    (a[4] ?? '') === (b[4] ?? '') &&
    Number(b[2]) === expected
  )
}

// Whether a differing pair of lines could hold anything but Lute's or Vditor's change: a tab or an
// indent of 4 or more columns may be indented code (also inside a list item), so it is refused.
function riskyIndent(host: string, shown: string): boolean {
  return [host, shown].some(
    (line) => /^\s*\t/u.test(line) || /^ {4,}/u.test(line),
  )
}

// Lines inside a fenced, math or HTML block: text that no relation may touch.
function opaqueMap(lines: string[]): boolean[] {
  const fenced = fenceMap(lines)
  const html = htmlMap(lines, fenced)
  return fenced.map((inFence, index) => inFence || html[index])
}

const afterParagraphText = (previous: string): boolean =>
  previous.trim() !== '' && !LIST_ITEM.test(previous.trimStart())

function linesRelate(host: string, shown: string): boolean {
  const hostLines = host.split('\n')
  const shownLines = shown.split('\n')
  if (hostLines.length !== shownLines.length) return false
  const hostOpaque = opaqueMap(hostLines)
  const shownOpaque = opaqueMap(shownLines)
  const hostRoles = tableRoles(hostLines, hostOpaque)
  const shownRoles = tableRoles(shownLines, shownOpaque)
  const list: ListState = { open: new Map() }
  return shownLines.every((line, index) => {
    // Opaque content is text, but it still ends the open lists at its indent or deeper, so a list
    // that a fenced or HTML block interrupted does not continue its numbering.
    const indent = line.length - line.trimStart().length
    const expected = continuedNumber(
      list,
      shownOpaque[index] ? `${' '.repeat(indent)}x` : line,
      afterParagraphText(index > 0 ? shownLines[index - 1] : ''),
    )
    if (line === hostLines[index]) return true
    if (hostOpaque[index] || shownOpaque[index]) return false
    if (riskyIndent(hostLines[index], line)) return false
    const role = shownRoles[index]
    if (role !== null && role === hostRoles[index])
      return sameTableRow(hostLines[index], line, role)
    return renumberedItem(hostLines[index], line, expected)
  })
}

/**
 * Whether the Source text `rendered` is the host's `exact` text as Lute or Vditor show it: equal up
 * to line endings, with only table padding (and delimiter dashes), sequential ordered-list numbers
 * and one more trailing line break allowed to differ. Anything else, including any difference inside
 * a fenced code block, is refused.
 */
export function svSourceDerivesFrom(exact: string, rendered: string): boolean {
  const host = normalizeEol(exact)
  if (host === rendered) return true
  if (linesRelate(host, rendered)) return true
  return (
    host.endsWith('\n') &&
    rendered.endsWith('\n') &&
    linesRelate(host, rendered.slice(0, -1))
  )
}
