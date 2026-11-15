import type { MovableKind } from '../../../src/shared/block-move'
import type { UnitSpinResult } from '../editing/unit-spin'
import type { UnitMode } from '../util/unit-changes'

// Per-unit Lute calls on HTML or Markdown strings (Task 733). Pure string functions: the Lute
// object is a parameter, so the webview passes the live wrapped `vditor.lute` and tests pass the
// real Lute with the production patches. Every result has its trailing newlines removed.

export interface UnitLute {
  VditorIRDOM2Md(html: string): string
  Md2VditorIRDOM(markdown: string): string
  /** Task 733 / 013: absent means 'ir'. 'wysiwyg' selects the WYSIWYG code-block text path in serializeBlockHtml. */
  readonly mode?: UnitMode
}

/** Task 733 / 013 (shared rules 3.12): the live Lute with the serializer pairs of both visual modes. */
export interface ModeLute {
  VditorIRDOM2Md(html: string): string
  Md2VditorIRDOM(markdown: string): string
  SpinVditorIRDOM(html: string): string
  VditorDOM2Md(html: string): string
  Md2VditorDOM(markdown: string): string
  SpinVditorDOM(html: string): string
}

/**
 * The model's serializer pair for `mode`, methods bound once (called once per build): the WYSIWYG pair
 * (`VditorDOM2Md`, `Md2VditorDOM`) is mapped onto the `UnitLute` names, so every unit helper serves both modes.
 */
export function unitLuteOf(lute: ModeLute, mode: UnitMode): UnitLute {
  if (mode === 'ir')
    return {
      VditorIRDOM2Md: lute.VditorIRDOM2Md.bind(lute),
      Md2VditorIRDOM: lute.Md2VditorIRDOM.bind(lute),
    }
  return {
    VditorIRDOM2Md: lute.VditorDOM2Md.bind(lute),
    Md2VditorIRDOM: lute.Md2VditorDOM.bind(lute),
    mode: 'wysiwyg',
  }
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

// ---- Task 733 / 012-5: the code-block text path ----
//
// A fenced code block in the IR DOM is the open marker, the info string, the body `code` element,
// the preview and the close marker. Lute writes it back as `open + info + '\n' + body + close`, so
// its canon is built here from the outerHTML string without a Lute call (about 28 ms for a 40-line
// block). Every shape whose Lute bytes this cannot reproduce exactly returns undefined and takes
// the Lute path: an element or entity other than the DOM serializer's own in the body, a body text
// Lute rewrites (see BODY_REWRITTEN) and a body line that could close the fence.

/**
 * The exact Lute render of a fenced code block; the groups are the open marker, the info string, the
 * raw body HTML and the close marker. Task 733 / 012-11: the body `code` may also carry `hljs`, which
 * `editing/code-source.ts` adds to every editable source in the webview; Lute reads the language from
 * the info span, so the class is no source (proven against `VditorIRDOM2Md` in unit-lute.test.ts).
 * 012-11 R1: the block element and its source `pre` may also carry the native context menu stamp of
 * `chrome/webview-context.ts` (`data-vscode-context`, the code value only); Lute skips the attribute.
 */
const CODE_BLOCK =
  /^<div data-block="0" data-type="code-block" class="vditor-ir__node(?: vditor-ir__node--expand)?"(?: data-vscode-context="\{&quot;webviewSection&quot;:&quot;code&quot;\}")?><span data-type="code-block-open-marker">(`{3,}|~{3,})<\/span><span class="vditor-ir__marker vditor-ir__marker--info" data-type="code-block-info">\u200b?([A-Za-z0-9_.+#-]*)<\/span><pre class="vditor-ir__marker--pre vditor-ir__marker"(?: data-vscode-context="\{&quot;webviewSection&quot;:&quot;code&quot;\}")?><code(?: class="(?:language-[A-Za-z0-9_.+#-]+(?: hljs)?|hljs)")?>([^<&]*(?:(?:<wbr>|&(?:lt|gt|amp|quot|#39);)[^<&]*)*)<\/code><\/pre>(?:<pre class="vditor-ir__preview"[^>]*>[\s\S]*<\/pre>)?<span data-type="code-block-close-marker">(`{3,}|~{3,})<\/span><\/div>$/u

/**
 * Body text Lute does not write back as it is: a character reference once decoded (Lute decodes the
 * text a second time), a carriage return, a C0 or C1 control other than tab, line feed, vertical tab
 * and form feed, a no-break or zero-width space, a line or paragraph separator, a tab at a line end,
 * and an unpaired surrogate. Checked on the raw HTML body, where `&amp;` stands for `&`.
 */
const BODY_REWRITTEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters Lute drops or rewrites are what this pattern detects
  /&amp;(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);|[\0-\x08\x0d\x0e-\x1a\x1c-\x1f\x7f-\xa0\u200b\u2028\u2029]|\t(?:\n|$)|[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/iu

const ENTITY = /&(lt|gt|amp|quot|#39);/gu
const ENTITY_TEXT: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  '#39': "'",
}

/** True when the line of `body` from `start` is a closing fence: up to 3 spaces, a run of `fence` of at least `length`, then only spaces or tabs. */
function lineClosesFence(
  body: string,
  start: number,
  fence: number,
  length: number,
): boolean {
  let at = start
  while (at - start < 3 && body.charCodeAt(at) === 32) at++
  const runStart = at
  while (body.charCodeAt(at) === fence) at++
  if (at - runStart < length) return false
  // charCodeAt past the end is NaN, so the scans stop at the end of the body.
  while (body.charCodeAt(at) === 32 || body.charCodeAt(at) === 9) at++
  return at === body.length || body.charCodeAt(at) === 10
}

/** True when a line of `body` is a closing fence for the open marker `open`. */
function closesFence(body: string, open: string): boolean {
  const fence = open.charCodeAt(0)
  for (let start = 0; start < body.length; ) {
    if (lineClosesFence(body, start, fence, open.length)) return true
    const end = body.indexOf('\n', start)
    if (end === -1) return false
    start = end + 1
  }
  return false
}

/** Lute's canon of one fenced code block from its outerHTML, or undefined when only Lute can say. */
function codeBlockCanon(html: string): string | undefined {
  const match = CODE_BLOCK.exec(html)
  if (!match) return undefined
  const [, open, info, raw, close] = match
  if (close.charCodeAt(0) !== open.charCodeAt(0) || close.length < open.length)
    return undefined
  if (BODY_REWRITTEN.test(raw) || closesFence(raw, open)) return undefined
  // Lute drops the caret marker and reads the DOM serializer's entities as text.
  const text =
    raw.indexOf('<') === -1 && raw.indexOf('&') === -1
      ? raw
      : raw
          .replaceAll('<wbr>', '')
          .replace(ENTITY, (_, name: string) => ENTITY_TEXT[name])
  if (text === '') return `${open}${info}\n${close}`
  return text.endsWith('\n')
    ? `${open}${info}\n${text}${close}`
    : `${open}${info}\n${text}\n${close}`
}

/**
 * Task 733 / 013: the exact Lute render of a fenced code block in the WYSIWYG DOM; the groups are the
 * fence marker (`data-marker`, written as both the open and the close fence), the info string (the
 * `language-` class) and the raw body HTML. The source `pre` carries Vditor's `style` toggle while the
 * block is entered; the webview's context stamp and `hljs` may be present, as in IR.
 */
const WYSIWYG_CODE_BLOCK =
  /^<div class="vditor-wysiwyg__block" data-type="code-block" data-block="0" data-marker="(`{3,}|~{3,})"(?: data-vscode-context="\{&quot;webviewSection&quot;:&quot;code&quot;\}")?><pre class="vditor-wysiwyg__pre"(?: style="[^"]*")?(?: data-vscode-context="\{&quot;webviewSection&quot;:&quot;code&quot;\}")?><code(?: class="(?:language-([A-Za-z0-9_.+#-]+)(?: hljs)?|hljs)")?>([^<&]*(?:(?:<wbr>|&(?:lt|gt|amp|quot|#39);)[^<&]*)*)<\/code><\/pre>(?:<pre class="vditor-wysiwyg__preview"[^>]*>[\s\S]*<\/pre>)?<\/div>$/u

/** Lute's canon of one WYSIWYG fenced code block from its outerHTML, or undefined when only Lute can say. */
function wysiwygCodeBlockCanon(html: string): string | undefined {
  const match = WYSIWYG_CODE_BLOCK.exec(html)
  if (!match) return undefined
  const [, fence, info = '', raw] = match
  if (BODY_REWRITTEN.test(raw) || closesFence(raw, fence)) return undefined
  const text =
    raw.indexOf('<') === -1 && raw.indexOf('&') === -1
      ? raw
      : raw
          .replaceAll('<wbr>', '')
          .replace(ENTITY, (_, name: string) => ENTITY_TEXT[name])
  // An empty body: Lute writes a blank line for it; only Lute says which.
  if (text === '' || text === '\n') return undefined
  return text.endsWith('\n')
    ? `${fence}${info}\n${text}${fence}`
    : `${fence}${info}\n${text}\n${fence}`
}

/** Canon of a block, or of the member elements of one source block, from their outerHTML strings. */
export function serializeBlockHtml(
  lute: UnitLute,
  outerHtml: readonly string[],
): string {
  // Task 733 / 012-5: a lone fenced code block takes the text path (no Lute call), see codeBlockCanon;
  // 013: the WYSIWYG DOM has its own shape (wysiwygCodeBlockCanon).
  if (outerHtml.length === 1) {
    const canon =
      lute.mode === 'wysiwyg'
        ? wysiwygCodeBlockCanon(outerHtml[0])
        : codeBlockCanon(outerHtml[0])
    if (canon !== undefined) return canon
  }
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

/** Task 733 / 013: the spin entry of `mode` on the live wrapped Lute; the caller reads the live Lute at call time. */
export function spinLuteOf(lute: ModeLute, mode: UnitMode): SpinLute {
  if (mode === 'ir') return lute
  // One entry per Lute object: the keystroke path reads it on every spin and allocates nothing.
  let spin = wysiwygSpins.get(lute)
  if (!spin) {
    spin = { SpinVditorIRDOM: (html) => lute.SpinVditorDOM(html) }
    wysiwygSpins.set(lute, spin)
  }
  return spin
}
const wysiwygSpins = new WeakMap<ModeLute, SpinLute>()

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

const LIST_CLOSE_IN_BODY = /<\/(?:ul|ol)><(?:ul|ol)\b/u
const ONE_ITEM = /<li\b[\s\S]*?<\/li>/gu

/** `body` holds one item per input item, each with the input's class and loose form. */
function sameItems(itemsOuterHtml: readonly string[], body: string): boolean {
  const items = body.match(ONE_ITEM)
  if (!items || items.length !== itemsOuterHtml.length) return false
  if (items.join('') !== body) return false
  return items.every((item, k) => {
    const inputOpen = LI_OPEN.exec(itemsOuterHtml[k])?.[0] ?? ''
    const outputOpen = LI_OPEN.exec(item)?.[0] ?? ''
    return (
      classOf(inputOpen) === classOf(outputOpen) &&
      isLoose(itemsOuterHtml[k]) === isLoose(item)
    )
  })
}

/**
 * Spins consecutive top-level items of one list together, inside `listShellOpenTag` (Task 733 / 011,
 * shared rules 3.8: the item split by Enter and its neighbour). `spun.html` is the concatenated
 * outerHTML of exactly `itemsOuterHtml.length` items. Nested blocks, a changed shell (for an ordered
 * pair the caller builds it from the first item's number), a changed class or loose form of any item,
 * a second list or another item count are refused.
 */
export function spinListItemsHtml(
  lute: SpinLute,
  listShellOpenTag: string,
  itemsOuterHtml: readonly string[],
): UnitSpinResult {
  for (const item of itemsOuterHtml) if (BLOCK_IN_ITEM.test(item)) return NESTED
  try {
    const tag =
      /^<(ul|ol)\b/iu.exec(listShellOpenTag)?.[1].toLowerCase() ?? 'ul'
    const out = trimNewlines(
      lute.SpinVditorIRDOM(
        `${listShellOpenTag}${itemsOuterHtml.join('')}</${tag}>`,
      ),
    )
    const match = LIST_ITEM_OUTPUT.exec(out)
    if (!match || match[2] !== tag) return SHAPE
    if (
      normalizedOpenTag(match[1], tag) !==
      normalizedOpenTag(listShellOpenTag, tag)
    )
      return SHAPE
    const body = match[3]
    // Two lists came out (the greedy match spans the closing and opening tags between them).
    if (LIST_CLOSE_IN_BODY.test(body)) return SHAPE
    if (BLOCK_IN_ITEM.test(body)) return NESTED
    return sameItems(itemsOuterHtml, body)
      ? { kind: 'spun', html: body }
      : SHAPE
  } catch {
    return SHAPE
  }
}
