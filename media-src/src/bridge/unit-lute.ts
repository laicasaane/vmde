import type { MovableKind } from '../../../src/shared/block-move'

// Per-unit Lute calls on HTML or Markdown strings (Task 733). Pure string functions: the Lute
// object is a parameter, so the webview passes the live wrapped `vditor.lute` and tests pass the
// real Lute with the production patches. Every result has its trailing newlines removed.

export interface UnitLute {
  VditorIRDOM2Md(html: string): string
  Md2VditorIRDOM(markdown: string): string
}

const trimNewlines = (text: string): string => text.replace(/\n+$/u, '')

// A thematic break alone at byte zero reads as front matter (`---`), so it is rendered after a
// paragraph line and a blank line, as the block handle's fragment proof does.
const THEMATIC_CONTEXT = 'VMDE proof context\n\n'

/** Content between the pipes of the first line of a one-cell table, trimmed. */
function firstCell(markdown: string): string {
  const line = markdown.split('\n')[0]
  const start = line.startsWith('|') ? 1 : 0
  const end =
    line.endsWith('|') && line.length > start ? line.length - 1 : line.length
  return line.slice(start, end).trim()
}

/** Canon of a block, or of the member elements of one source block, from their outerHTML strings. */
export function serializeBlockHtml(
  lute: UnitLute,
  outerHtml: readonly string[],
): string {
  return trimNewlines(lute.VditorIRDOM2Md(outerHtml.join('')))
}

/** Canon of one table cell from its innerHTML, serialized in a one-cell table. */
export function serializeCellHtml(
  lute: UnitLute,
  cellInnerHtml: string,
): string {
  // A paragraph wrapper is the wrong context: a `|` in a code span is escaped only in a table.
  const html = `<table data-block="0"><thead><tr><th>${cellInnerHtml}</th></tr></thead></table>`
  return firstCell(trimNewlines(lute.VditorIRDOM2Md(html)))
}

/** Canon of one top-level list item, serialized inside `listShellOpenTag` (the list's own opening tag). */
export function serializeListItemHtml(
  lute: UnitLute,
  listShellOpenTag: string,
  itemOuterHtml: string,
): string {
  const tag = /^<(ul|ol)\b/iu.exec(listShellOpenTag)?.[1].toLowerCase() ?? 'ul'
  return trimNewlines(
    lute.VditorIRDOM2Md(`${listShellOpenTag}${itemOuterHtml}</${tag}>`),
  )
}

/** serialize(render(source)) for a block source chunk of `kind`; adds the context a kind needs to parse alone (thematic break). */
export function roundTripBlock(
  lute: UnitLute,
  kind: MovableKind,
  source: string,
): string {
  if (kind === 'thematic') {
    const out = trimNewlines(
      lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(THEMATIC_CONTEXT + source)),
    )
    // A missing prefix means the context did not hold; NUL never equals a canon.
    return out.startsWith(THEMATIC_CONTEXT.trimEnd())
      ? out.slice(THEMATIC_CONTEXT.trimEnd().length).replace(/^\n+/u, '')
      : '\u0000'
  }
  return trimNewlines(lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(source)))
}

/** serialize(render(source)) for a cell source span, in a one-cell table. */
export function roundTripCell(lute: UnitLute, cellSource: string): string {
  const markdown = `| ${cellSource} |\n| - |`
  return firstCell(
    trimNewlines(lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(markdown))),
  )
}

export type ColumnAlign = 'left' | 'center' | 'right' | 'default'

const DELIMITER_CELL: Record<ColumnAlign, string> = {
  left: ':-',
  center: ':-:',
  right: '-:',
  default: '-',
}

/** A delimiter row for these alignments in the unpadded form (`:-`, `:-:`, `-:`, `-`), built in JavaScript (no Lute call). Lute pads delimiter cells to the column width; this family does not. */
export function delimiterLine(align: readonly ColumnAlign[]): string {
  return `| ${align.map((a) => DELIMITER_CELL[a]).join(' | ')} |`
}
