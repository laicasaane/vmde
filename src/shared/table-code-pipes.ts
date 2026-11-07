// Table cells and code spans: one code-span-aware reading of `|` for host and webview (Task 704).
//
// Lute (like cmark-gfm / GitHub) splits a table row into cells on every unescaped `|` BEFORE
// inline parsing, so a `|` between the backticks of a code span is taken for a column separator:
// the row's trailing cells are dropped and the text is lost on the next reserialize. Decision D1
// (Owner): inside a table row, a `|` that sits inside a code span belongs to the code span.
// Lute cannot be told that, so we rewrite the text on the way IN: `escapeTableCodePipes` turns each
// such `|` into `\|` before Lute parses (GFM reads `\|` in a cell as a literal `|`, also in code),
// and `escapeCellCodePipesInIrHtml` does the same for the IR DOM that `VditorIRDOM2Md` serializes
// (Lute writes a cell code span `x \| y` back as `x | y`, which would re-split the row).
// `restoreCodeSpanPipeForm` gives the save path the source bytes back.
//
// The inline-math escape (Vditor #1904, `$a|b$` in a cell) stays as it was before this task: it
// repairs an over-split row only, and only when the escape restores the header's cell count.
//
// Pure string transforms, no DOM and no Node API: the extension host (lute-host.ts, doc-sync.ts,
// editor-session.ts, minimal-diff-writeback.ts) and the webview (preload.ts, table commands) share
// this module, so the two sides cannot disagree about where a cell ends.

import { FENCE } from './md-scan'

const BACKSLASH = 92
const BACKTICK = 96
const PIPE = 124

// A GFM delimiter row: cells of only `-`, optional leading/trailing `:`, and spaces.
const DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

// CommonMark HTML blocks 1–5 end at a line that matches their end condition; 6 and 7 end at a
// blank line. A table-like line inside any of them is HTML, not a table.
const HTML_START_END: Array<[RegExp, RegExp]> = [
  [
    /^ {0,3}<(?:script|pre|style|textarea)(?:[\s>]|$)/i,
    /<\/(?:script|pre|style|textarea)>/i,
  ],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [/^ {0,3}<![A-Za-z]/, />/],
]
const HTML_TYPE6 =
  /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s/>]|$)/i
const HTML_TYPE7 =
  /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/
const LIST_MARKER = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:\s|$)/

/** Start of the next backtick run of exactly `run` characters at or after `from`, or -1. */
function findCloseRun(s: string, from: number, run: number): number {
  let at = s.indexOf('`', from)
  while (at !== -1) {
    let end = at
    while (s.charCodeAt(end) === BACKTICK) end++
    if (end - at === run) return at
    at = s.indexOf('`', end)
  }
  return -1
}

/**
 * Walk `line` the CommonMark way and call `onSpan(innerStart, innerEnd)` for each matched code span
 * (a backtick run of n closes only at the next run of exactly n; an unmatched run is literal; no
 * backslash escape inside code) and `onPipe(offset)` for each `|` outside code that no odd run of
 * backslashes escapes. Outside code, `\x` is consumed as a pair, so a `\`` never opens a span and
 * `\\|` is a separator (backslash parity, Task 704 P1).
 */
function scanRow(
  line: string,
  onSpan: ((innerStart: number, innerEnd: number) => void) | null,
  onPipe: ((offset: number) => void) | null,
): void {
  const n = line.length
  let i = 0
  while (i < n) {
    const c = line.charCodeAt(i)
    if (c === BACKSLASH) {
      i += 2
    } else if (c === BACKTICK) {
      let end = i
      while (line.charCodeAt(end) === BACKTICK) end++
      const run = end - i
      const close = findCloseRun(line, end, run)
      if (close === -1) {
        i = end
      } else {
        onSpan?.(end, close)
        i = close + run
      }
    } else {
      if (c === PIPE) onPipe?.(i)
      i++
    }
  }
}

/** Absolute offsets of the outer and separating pipes of a table row: no pipe inside a code span, no escaped pipe. */
export function tableRowPipeOffsets(line: string): number[] {
  const offsets: number[] = []
  if (line.indexOf('|') === -1) return offsets
  scanRow(line, null, (offset) => offsets.push(offset))
  return offsets
}

/**
 * Split one table row into raw cells (not trimmed): strip the optional outer pipes, split on the
 * pipes `tableRowPipeOffsets` reports. Same contract as `splitRowCells` (md-scan) wherever no code
 * span holds a pipe.
 */
export function splitTableRowCells(line: string): string[] {
  const t = line.trim()
  const offsets = tableRowPipeOffsets(t)
  let from = 0
  let to = offsets.length
  let start = 0
  let end = t.length
  if (to > 0 && offsets[0] === 0) {
    start = 1
    from = 1
  }
  if (to > from && offsets[to - 1] === t.length - 1) {
    end = t.length - 1
    to--
  }
  const cells: string[] = []
  for (let k = from; k < to; k++) {
    cells.push(t.slice(start, offsets[k]))
    start = offsets[k] + 1
  }
  cells.push(t.slice(start, end))
  return cells
}

/** Escape each bare `|` inside the code spans of one row; returns the same string when none. */
function escapeRowCodePipes(row: string): string {
  if (row.indexOf('|') === -1 || row.indexOf('`') === -1) return row
  let out: string | null = null
  let copied = 0
  scanRow(
    row,
    (innerStart, innerEnd) => {
      for (let k = innerStart; k < innerEnd; k++) {
        if (row.charCodeAt(k) !== PIPE) continue
        // An already-escaped pipe stays as it is, so the escape is idempotent.
        if (k > innerStart && row.charCodeAt(k - 1) === BACKSLASH) continue
        out = `${out ?? ''}${row.slice(copied, k)}\\`
        copied = k
      }
    },
    null,
  )
  return out === null ? row : `${out}${row.slice(copied)}`
}

// Escape `|` inside inline math (`$…$`) of one row, leaving code spans and existing escapes as
// they are. Math uses the CommonMark-math flanking rules (open `$` not followed by whitespace;
// close `$` not preceded by whitespace and not followed by a digit) so prices like `$5` don't open
// a span.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: char-by-char $-span/code-span/escape state machine for pipe-escaping inside table cells; carried over from the former table-pipe-escape (task 469 baseline)
function escapeRowMathPipes(row: string): string {
  let out = ''
  let i = 0
  const n = row.length
  while (i < n) {
    const c = row[i]
    if (c === '\\') {
      out += c + (row[i + 1] ?? '')
      i += 2
      continue
    }
    if (c === '`') {
      let end = i
      while (row.charCodeAt(end) === BACKTICK) end++
      const close = findCloseRun(row, end, end - i)
      const stop = close === -1 ? end : close + (end - i)
      out += row.slice(i, stop)
      i = stop
      continue
    }
    if (c === '$') {
      const next = row[i + 1]
      if (next === undefined || /\s/.test(next) || next === '$') {
        out += c
        i++
        continue
      }
      let j = i + 1
      let close = -1
      while (j < n) {
        if (
          row[j] === '$' &&
          row[j - 1] !== '\\' &&
          !/\s/.test(row[j - 1]) &&
          !/[0-9]/.test(row[j + 1] ?? '')
        ) {
          close = j
          break
        }
        j++
      }
      if (close === -1) {
        out += c
        i++
        continue
      }
      out += `$${row.slice(i + 1, close).replace(/(?<!\\)\|/g, '\\|')}$`
      i = close + 1
      continue
    }
    out += c
    i++
  }
  return out
}

// D1 is strict for code spans (every pipe in a code span of a table row is escaped, no cell-count
// guard). The math escape is not: it applies only to a row whose cell count differs from the
// header's and only when the escape restores that count, so `| $5 | $6 |` is never touched.
function repairRow(
  row: string,
  expected: number,
  code: boolean,
  math: boolean,
): string {
  const escaped = code ? escapeRowCodePipes(row) : row
  if (!math || escaped.indexOf('$') === -1) return escaped
  if (splitTableRowCells(escaped).length === expected) return escaped
  const repaired = escapeRowMathPipes(escaped)
  return repaired !== escaped &&
    splitTableRowCells(repaired).length === expected
    ? repaired
    : escaped
}

/**
 * Escape the `|` of code spans (and, guarded, of inline math) in the rows of every GFM table of
 * `md`, so Lute keeps the span in one cell. Idempotent. Returns the SAME string when nothing
 * changes. Hot path (every keystroke spins IR and serializes blocks): no work without a `|`; the
 * code scan needs a backtick and the math scan a `$`; lines are walked with `indexOf('\n')`, and
 * a new string is built only from the first changed row on.
 *
 * Skipped like Lute skips them: fenced code, HTML blocks (CommonMark types 1–7) and indented code.
 * A table is a header line with a `|` followed by a delimiter row; its body runs to a blank line,
 * a line without `|`, a fence or an HTML-block start.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one line scan tracking fence / HTML-block / indented-code / list state next to table detection; splitting it would copy the state across functions and cost allocations on the keystroke hot path
export function escapeTableCodePipes(md: string): string {
  if (md.indexOf('|') === -1) return md
  const code = md.indexOf('`') !== -1
  const math = md.indexOf('$') !== -1
  if (!code && !math) return md

  let parts: string[] | null = null
  let copied = 0
  const rewrite = (start: number, end: number, expected: number) => {
    const row = md.slice(start, end)
    const next = repairRow(row, expected, code, math)
    if (next === row) return
    parts ??= []
    parts.push(md.slice(copied, start), next)
    copied = end
  }

  let fence: string | null = null
  let htmlEnd: RegExp | null = null
  let htmlUntilBlank = false
  let inList = false
  let prevBlank = true
  let prevParagraph = false
  let tableOpen = false
  let expected = 0
  let headerStart = -1
  let headerEnd = -1
  let nextPipe = -2

  for (let start = 0; start <= md.length; ) {
    let end = md.indexOf('\n', start)
    if (end === -1) end = md.length
    const next = end + 1
    const line = md.slice(start, end)
    const blank = line.trim() === ''
    let skipped = true // flipped to false only for a line that can belong to a table

    if (fence !== null) {
      const m = FENCE.exec(line)
      if (m && line.trim().startsWith(fence)) fence = null
    } else if (htmlEnd !== null) {
      if (htmlEnd.test(line)) htmlEnd = null
    } else if (htmlUntilBlank) {
      if (blank) htmlUntilBlank = false
    } else if (!blank) {
      skipped = false
      const indented = line.startsWith('    ') || line.startsWith('\t')
      if (indented && !prevParagraph && !inList) {
        // Indented code (a list item's indented continuation is not code, hence `inList`).
        skipped = true
      } else {
        if (!indented) {
          if (LIST_MARKER.test(line)) inList = true
          else if (prevBlank) inList = false
        }
        const m = FENCE.exec(line)
        if (m && !indented) {
          fence = m[1][0]
          skipped = true
        } else if (line.charCodeAt(line.search(/\S/)) === 60 /* < */) {
          for (const [startRe, endRe] of HTML_START_END) {
            if (!startRe.test(line)) continue
            if (!endRe.test(line)) htmlEnd = endRe
            skipped = true
            break
          }
          if (
            !skipped &&
            (HTML_TYPE6.test(line) || (!prevParagraph && HTML_TYPE7.test(line)))
          ) {
            htmlUntilBlank = true
            skipped = true
          }
        }
      }
    }
    prevParagraph = !skipped && !blank
    prevBlank = blank
    if (skipped || blank) {
      tableOpen = false
      headerStart = -1
    } else {
      if (nextPipe < start) {
        const at = md.indexOf('|', start)
        nextPipe = at === -1 ? Number.POSITIVE_INFINITY : at
      }
      const hasPipe = nextPipe < end
      if (tableOpen) {
        if (hasPipe) rewrite(start, end, expected)
        else {
          tableOpen = false
          headerStart = -1
        }
      } else if (hasPipe && headerStart !== -1 && DELIM.test(line)) {
        expected = splitTableRowCells(line).length
        rewrite(headerStart, headerEnd, expected)
        tableOpen = true
        headerStart = -1
      } else if (hasPipe) {
        headerStart = start
        headerEnd = end
      } else {
        headerStart = -1
      }
    }
    start = next
  }
  if (parts === null) return md
  const done: string[] = parts
  done.push(md.slice(copied))
  return done.join('')
}

const IR_CELL = /<t([dh])\b[^>]*>[\s\S]*?<\/t\1>/g
// Inline code in the IR DOM: the opening marker precedes the `<code>` that holds the text. Math
// (`data-type="math-inline"`) and inline-HTML markers use other node types and never match.
const IR_CODE =
  /(<span data-type="code"[^>]*><span class="vditor-ir__marker">`+<\/span><code[^>]*>)([\s\S]*?)(<\/code>)/g

/**
 * Escape the bare `|` of the inline code spans inside `<td>`/`<th>` of an IR DOM, in the text
 * segment of the `<code>` only (a caret `<wbr>` stays whole). The IR serializer reads this DOM, and
 * without the escape it writes a cell code span `x \| y` back as `x | y`. Returns the same string
 * unless a cell code text holds a bare pipe.
 */
export function escapeCellCodePipesInIrHtml(html: string): string {
  if (
    html.indexOf('|') === -1 ||
    html.indexOf('data-type="code"') === -1 ||
    (html.indexOf('<td') === -1 && html.indexOf('<th') === -1)
  )
    return html
  let parts: string[] | null = null
  let copied = 0
  IR_CELL.lastIndex = 0
  for (let cell = IR_CELL.exec(html); cell; cell = IR_CELL.exec(html)) {
    IR_CODE.lastIndex = 0
    for (let node = IR_CODE.exec(cell[0]); node; node = IR_CODE.exec(cell[0])) {
      const text = node[2]
      if (text.indexOf('|') === -1) continue
      const escaped = text.replace(/(?<!\\)\|/g, '\\|')
      if (escaped === text) continue
      const textStart = cell.index + node.index + node[1].length
      parts ??= []
      parts.push(html.slice(copied, textStart), escaped)
      copied = textStart + text.length
    }
  }
  if (parts === null) return html
  const done: string[] = parts
  done.push(html.slice(copied))
  return done.join('')
}

interface SpanInfo {
  start: number
  innerStart: number
  innerEnd: number
  end: number
  run: number
}

function codeSpansOf(text: string): SpanInfo[] {
  const spans: SpanInfo[] = []
  if (text.indexOf('`') === -1) return spans
  scanRow(
    text,
    (innerStart, innerEnd) => {
      let run = 0
      while (text.charCodeAt(innerStart - 1 - run) === BACKTICK) run++
      spans.push({
        start: innerStart - run,
        innerStart,
        innerEnd,
        end: innerEnd + run,
        run,
      })
    },
    null,
  )
  return spans
}

const unescapePipes = (s: string) => s.replace(/\\\|/g, '|')

/**
 * Save-path form of one edited table cell (Q3). `nextCell` is the serializer's cell text, in which
 * every code-span pipe may carry a `\`; `originalCell` is the source cell. A code span whose text
 * is unchanged (compared with `\|` read as `|`) takes its source bytes back, so `|` stays `|` and
 * `\|` stays `\|`. A changed or new span is written with a bare `|`. Spans pair up in document
 * order; outside code spans nothing changes.
 */
export function restoreCodeSpanPipeForm(
  originalCell: string,
  nextCell: string,
): string {
  const next = codeSpansOf(nextCell)
  if (next.length === 0) return nextCell
  const original = codeSpansOf(originalCell).map((span) => ({
    span,
    used: false,
  }))
  let out = ''
  let cursor = 0
  for (const span of next) {
    out += nextCell.slice(cursor, span.start)
    const inner = unescapePipes(nextCell.slice(span.innerStart, span.innerEnd))
    const hit = original.find(
      (o) =>
        !o.used &&
        o.span.run === span.run &&
        unescapePipes(
          originalCell.slice(o.span.innerStart, o.span.innerEnd),
        ) === inner,
    )
    if (hit) {
      hit.used = true
      out += originalCell.slice(hit.span.start, hit.span.end)
    } else {
      out += `${nextCell.slice(span.start, span.innerStart)}${inner}${nextCell.slice(span.innerEnd, span.end)}`
    }
    cursor = span.end
  }
  return out + nextCell.slice(cursor)
}

type LuteMethod = (...args: string[]) => string

/** The Lute entry points this module wraps (all optional, so a partial test double works). */
export interface TableCodePipesLute {
  Md2VditorIRDOM?: LuteMethod
  Md2VditorDOM?: LuteMethod
  Md2HTML?: LuteMethod
  FormatStr?: LuteMethod
  VditorIRDOM2Md?: LuteMethod
  SpinVditorIRDOM?: LuteMethod
  __vmdeTableCodePipes?: boolean
}

function wrapArgument(
  lute: TableCodePipesLute,
  name: keyof Omit<TableCodePipesLute, '__vmdeTableCodePipes'>,
  index: number,
  transform: (s: string) => string,
): void {
  const original = lute[name]
  if (typeof original !== 'function') return
  lute[name] = function (this: unknown, ...args: string[]) {
    args[index] = transform(args[index])
    return original.apply(this, args)
  }
}

/**
 * Make one Lute instance read a `|` inside a table-cell code span as part of the span. Wraps the
 * markdown parsers (`Md2VditorIRDOM`, `Md2VditorDOM`, `Md2HTML`, `FormatStr`) with the pre-parse
 * escape and the IR serializer/spin (`VditorIRDOM2Md`, `SpinVditorIRDOM`) with the IR DOM escape.
 * The WYSIWYG serializer already keeps `\|`, and the Source-mode renderers show the text as it is,
 * so `VditorDOM2Md`, `SpinVditorDOM` and the `*SVDOM` entry points stay unwrapped. Idempotent.
 * Install it FIRST: later patches (gap repair) then call the already-escaping methods.
 */
export function patchLuteTableCodePipes(lute: TableCodePipesLute): void {
  if (lute.__vmdeTableCodePipes) return
  lute.__vmdeTableCodePipes = true
  wrapArgument(lute, 'Md2VditorIRDOM', 0, escapeTableCodePipes)
  wrapArgument(lute, 'Md2VditorDOM', 0, escapeTableCodePipes)
  wrapArgument(lute, 'Md2HTML', 0, escapeTableCodePipes)
  // FormatStr(origin, markdown): the markdown is the second argument.
  wrapArgument(lute, 'FormatStr', 1, escapeTableCodePipes)
  wrapArgument(lute, 'VditorIRDOM2Md', 0, escapeCellCodePipesInIrHtml)
  wrapArgument(lute, 'SpinVditorIRDOM', 0, escapeCellCodePipesInIrHtml)
}
