import { splitRowCells } from '../../../src/shared/md-scan'

export interface SourceSelection {
  markdown: string
  startOffset: number
  endOffset: number
  caretOffset: number
}

export interface DomSelectionInput {
  editor: HTMLElement
  range: Range
  serialize: (html: string) => string
  canonicalMarkdown?: string
}

type DetachedMapper = (input: DomSelectionInput) => SourceSelection | null

interface CellSpan {
  contentStart: number
  contentEnd: number
  value: string
}

function withoutTerminalLf(markdown: string): string {
  return markdown.replace(/\n+$/u, '')
}

function cellFor(node: Node): HTMLTableCellElement | null {
  const element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const cell = element?.closest('td,th')
  return cell instanceof HTMLTableCellElement ? cell : null
}

function ownerFor(
  editor: HTMLElement,
  table: HTMLTableElement,
): Element | null {
  if (table.parentElement === editor) return table
  const wrapper = table.parentElement
  if (
    wrapper?.parentElement === editor &&
    wrapper.childElementCount === 1 &&
    wrapper.firstElementChild === table
  ) {
    return wrapper
  }
  return null
}

function htmlFor(nodes: Node[]): string {
  const root = document.createElement('div')
  for (const node of nodes) root.append(node.cloneNode(true))
  return root.innerHTML
}

function consumeAnchoredPartitions(
  markdown: string,
  prefix: string,
  table: string,
  suffix: string,
): { tableStart: number } | null {
  if (
    !table ||
    table.startsWith('\n') ||
    prefix?.startsWith('\n') ||
    suffix?.startsWith('\n')
  )
    return null
  let cursor = 0
  const consumeLf = () => {
    const start = cursor
    while (markdown[cursor] === '\n') cursor++
    return cursor - start
  }
  if (prefix) {
    if (!markdown.startsWith(prefix, cursor)) return null
    cursor += prefix.length
  }
  const beforeTable = consumeLf()
  if (prefix && beforeTable === 0) return null
  const tableStart = cursor
  if (!markdown.startsWith(table, cursor)) return null
  cursor += table.length
  const afterTable = consumeLf()
  if (suffix && afterTable === 0) return null
  if (suffix) {
    if (!markdown.startsWith(suffix, cursor)) return null
    cursor += suffix.length
  }
  consumeLf()
  return cursor === markdown.length ? { tableStart } : null
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: scans escaped cell separators in canonical table row source
function canonicalRowSpans(row: string): CellSpan[] | null {
  if (!row.startsWith('|') || !row.endsWith('|') || row.endsWith('\\|'))
    return null
  const delimiters: number[] = []
  for (let index = 1; index < row.length - 1; index++) {
    if (row[index] !== '|') continue
    let backslashes = 0
    for (
      let previous = index - 1;
      previous >= 1 && row[previous] === '\\';
      previous--
    )
      backslashes++
    if (backslashes > 1) return null
    if (backslashes === 0) delimiters.push(index)
  }
  const spans: CellSpan[] = []
  let start = 1
  for (const end of [...delimiters, row.length - 1]) {
    let contentStart = start
    let contentEnd = end
    while (contentStart < contentEnd && /[ \t]/u.test(row[contentStart]))
      contentStart++
    while (contentEnd > contentStart && /[ \t]/u.test(row[contentEnd - 1]))
      contentEnd--
    spans.push({
      contentStart,
      contentEnd,
      value: row.slice(contentStart, contentEnd),
    })
    start = end + 1
  }
  const shared = splitRowCells(row).map((cell) => cell.trim())
  return spans.length === shared.length &&
    spans.every((span, index) => span.value === shared[index])
    ? spans
    : null
}

function pathFrom(root: Node, node: Node): number[] | null {
  if (node === root) return []
  const path: number[] = []
  let current: Node | null = node
  while (current && current !== root) {
    const parent: Node | null = current.parentNode
    if (!parent) return null
    const index = Array.prototype.indexOf.call(parent.childNodes, current)
    if (index < 0) return null
    path.unshift(index)
    current = parent
  }
  return current === root ? path : null
}

function nodeAt(root: Node, path: number[]): Node | null {
  let current = root
  for (const index of path) {
    const child = current.childNodes[index]
    if (!child) return null
    current = child
  }
  return current
}

function cloneCellRange(cell: HTMLTableCellElement, range: Range) {
  const root = document.createElement('div')
  const paragraph = document.createElement('p')
  paragraph.dataset.block = '0'
  for (const child of Array.from(cell.childNodes))
    paragraph.append(child.cloneNode(true))
  root.append(paragraph)
  const mapEndpoint = (node: Node, offset: number) => {
    if (node === cell) return { node: paragraph as Node, offset }
    const path = pathFrom(cell, node)
    const mapped = path ? nodeAt(paragraph, path) : null
    return mapped ? { node: mapped, offset } : null
  }
  const start = mapEndpoint(range.startContainer, range.startOffset)
  const end = mapEndpoint(range.endContainer, range.endOffset)
  if (!start || !end) return null
  const cloneRange = document.createRange()
  try {
    cloneRange.setStart(start.node, start.offset)
    cloneRange.setEnd(end.node, end.offset)
  } catch {
    return null
  }
  return { root, range: cloneRange }
}

function tableShape(
  table: HTMLTableElement,
  selectedCell: HTMLTableCellElement,
): {
  rowIndex: number
  columnIndex: number
  rows: HTMLTableRowElement[]
} | null {
  if (
    table.querySelector('table') ||
    table.querySelector('[rowspan],[colspan]')
  )
    return null
  if (
    table.tHead?.rows.length !== 1 ||
    table.tBodies.length !== 1 ||
    (table.tFoot?.rows.length ?? 0) !== 0
  ) {
    return null
  }
  const rows = Array.from(table.rows)
  if (rows.length < 2) return null
  const width = rows[0].cells.length
  if (!width || rows.some((row) => row.cells.length !== width)) return null
  const row = selectedCell.parentElement?.closest('tr')
  const rowIndex = row ? rows.indexOf(row) : -1
  const columnIndex = row ? Array.from(row.cells).indexOf(selectedCell) : -1
  return rowIndex >= 0 && columnIndex >= 0
    ? { rowIndex, columnIndex, rows }
    : null
}

/**
 * Maps a selection in one ordinary table cell to frozen canonical Markdown. `undefined` means
 * the range is not table-local and callers should use their existing generic marker mapper;
 * `null` means table-local but not safely provable.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validates detached table identity, row boundaries, and directional selection together
export function tableSourceSelectionFromDom(
  input: DomSelectionInput,
  mapDetached: DetachedMapper,
): SourceSelection | null | undefined {
  const { editor, range, serialize, canonicalMarkdown } = input
  const startCell = cellFor(range.startContainer)
  const endCell = cellFor(range.endContainer)
  if (!startCell && !endCell) return undefined
  if (!startCell || startCell !== endCell || !canonicalMarkdown) return null
  if (
    !editor.contains(range.startContainer) ||
    !editor.contains(range.endContainer)
  )
    return null
  const table = startCell.closest('table')
  if (!(table instanceof HTMLTableElement) || table.closest('li,blockquote'))
    return null
  const owner = ownerFor(editor, table)
  if (
    !owner ||
    (owner !== table && owner.querySelectorAll('table').length !== 1)
  )
    return null
  const shape = tableShape(table, startCell)
  if (!shape) return null

  const nodes = Array.from(editor.childNodes)
  const ownerIndex = nodes.indexOf(owner)
  if (ownerIndex < 0) return null
  const prefix = withoutTerminalLf(
    serialize(htmlFor(nodes.slice(0, ownerIndex))),
  )
  const tableMarkdown = withoutTerminalLf(serialize(htmlFor([owner])))
  const suffix = withoutTerminalLf(
    serialize(htmlFor(nodes.slice(ownerIndex + 1))),
  )
  const boundary = consumeAnchoredPartitions(
    canonicalMarkdown,
    prefix,
    tableMarkdown,
    suffix,
  )
  if (
    !boundary ||
    canonicalMarkdown.slice(
      boundary.tableStart,
      boundary.tableStart + tableMarkdown.length,
    ) !== tableMarkdown
  )
    return null

  const lines = tableMarkdown.split('\n')
  if (lines.length !== shape.rows.length + 1) return null
  const delimiter = canonicalRowSpans(lines[1])
  if (
    !delimiter ||
    delimiter.length !== shape.rows[0].cells.length ||
    !delimiter.every((span) => /^:?-+:?$/u.test(span.value))
  )
    return null
  const canonicalRow = shape.rowIndex === 0 ? 0 : shape.rowIndex + 1
  const row = lines[canonicalRow]
  const spans = canonicalRowSpans(row)
  if (!spans || spans.length !== shape.rows[0].cells.length) return null
  const span = spans[shape.columnIndex]
  if (!span) return null
  const rowStart = lines
    .slice(0, canonicalRow)
    .reduce((offset, line) => offset + line.length + 1, 0)

  const cloned = cloneCellRange(startCell, range)
  if (!cloned) return null
  const local = mapDetached({
    editor: cloned.root,
    range: cloned.range,
    serialize,
  })
  if (!local || withoutTerminalLf(local.markdown) !== span.value) return null
  if (
    local.startOffset > span.value.length ||
    local.endOffset > span.value.length
  )
    return null
  const startOffset =
    boundary.tableStart + rowStart + span.contentStart + local.startOffset
  const endOffset =
    boundary.tableStart + rowStart + span.contentStart + local.endOffset
  if (
    startOffset > endOffset ||
    endOffset > canonicalMarkdown.length ||
    canonicalMarkdown.slice(startOffset, endOffset) !==
      local.markdown.slice(local.startOffset, local.endOffset)
  ) {
    return null
  }
  return {
    markdown: canonicalMarkdown,
    startOffset,
    endOffset,
    caretOffset: endOffset,
  }
}
