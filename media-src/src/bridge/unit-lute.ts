import type { MovableKind } from '../../../src/shared/block-move'
import type { UnitSpinResult } from '../editing/unit-spin'

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

// ---- Unit spin (Task 733 / 002) ----

/** The spin entry of the live wrapped Lute (gap repair, code pipes, wiki, line breaks, html-subscript). */
export interface SpinLute {
  SpinVditorIRDOM(html: string): string
}

const SHAPE: UnitSpinResult = { kind: 'refused', reason: 'shape' }
const NESTED: UnitSpinResult = { kind: 'refused', reason: 'nested' }

/** A one-cell spin output: exactly one table, thead, tr and th, no tbody, no second cell. */
const ONE_CELL_TABLE =
  /^<table\b[^>]*><thead\b[^>]*><tr\b[^>]*><th\b[^>]*>([\s\S]*)<\/th><\/tr><\/thead><\/table>$/u
const CELL_TAGS = /<(?:table|thead|tbody|tfoot|tr|th|td)\b/gu
const BLOCK_IN_ITEM = /<(?:ul|ol|blockquote|pre|table)\b/iu
const LIST_ITEM_OUTPUT = /^(<(ul|ol)\b[^>]*>)(<li\b[\s\S]*<\/li>)<\/\2>$/u
const LI_OPEN = /^<li\b[^>]*>/u

/** Count of matches of a global regex in `text`, without building an array. */
function countMatches(pattern: RegExp, text: string): number {
  pattern.lastIndex = 0
  let count = 0
  while (pattern.exec(text) !== null) count++
  return count
}

/** An opening list tag as the DOM serializes it, so entity spelling does not make two equal tags differ. */
function normalizedOpenTag(openTag: string, tag: string): string {
  const holder = document.createElement('template')
  holder.innerHTML = `${openTag}</${tag}>`
  return holder.content.firstElementChild?.outerHTML ?? openTag
}

/** The `class` attribute value of an opening tag, or ''. */
const classOf = (openTag: string): string =>
  /\sclass="([^"]*)"/u.exec(openTag)?.[1] ?? ''

/** True when the first child of the `li` is a paragraph (the loose form). */
const isLoose = (itemHtml: string): boolean =>
  /^<li\b[^>]*>\s*<p\b/u.test(itemHtml)

/**
 * Spins one table cell alone, in a one-cell table (the shape `serializeCellHtml` serializes in).
 * `spun.html` is the new innerHTML of the cell, caret marker included. Any other shape of output
 * (a typed pipe splits the cell, for example) is refused so the block spin runs.
 */
export function spinCellHtml(
  lute: SpinLute,
  cellInnerHtml: string,
): UnitSpinResult {
  try {
    const out = trimNewlines(
      lute.SpinVditorIRDOM(
        `<table data-block="0"><thead><tr><th>${cellInnerHtml}</th></tr></thead></table>`,
      ),
    )
    const match = ONE_CELL_TABLE.exec(out)
    if (!match || countMatches(CELL_TAGS, out) !== 4) return SHAPE
    return { kind: 'spun', html: match[1] }
  } catch {
    return SHAPE
  }
}

/**
 * Spins one top-level list item alone, inside its list's own opening tag. `spun.html` is the new
 * outerHTML of the `li`. Nested lists, quotes, fences and tables, a changed class, a changed loose
 * form or any output other than one item in a list of the same tag are refused.
 */
export function spinListItemHtml(
  lute: SpinLute,
  listShellOpenTag: string,
  itemOuterHtml: string,
): UnitSpinResult {
  if (BLOCK_IN_ITEM.test(itemOuterHtml)) return NESTED
  try {
    const tag =
      /^<(ul|ol)\b/iu.exec(listShellOpenTag)?.[1].toLowerCase() ?? 'ul'
    const out = trimNewlines(
      lute.SpinVditorIRDOM(`${listShellOpenTag}${itemOuterHtml}</${tag}>`),
    )
    const match = LIST_ITEM_OUTPUT.exec(out)
    if (!match || match[2] !== tag) return SHAPE
    // The list shell must be unchanged: a changed `data-tight`, `data-marker` or `class` is the block spin's work.
    if (
      normalizedOpenTag(match[1], tag) !==
      normalizedOpenTag(listShellOpenTag, tag)
    )
      return SHAPE
    const item = match[3]
    if (BLOCK_IN_ITEM.test(item)) return NESTED
    if (item.indexOf('<li', 3) !== -1) return SHAPE
    const inputOpen = LI_OPEN.exec(itemOuterHtml)?.[0] ?? ''
    const outputOpen = LI_OPEN.exec(item)?.[0] ?? ''
    if (classOf(inputOpen) !== classOf(outputOpen)) return SHAPE
    if (isLoose(itemOuterHtml) !== isLoose(item)) return SHAPE
    return { kind: 'spun', html: item }
  } catch {
    return SHAPE
  }
}
