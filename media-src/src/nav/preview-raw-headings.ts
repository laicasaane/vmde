// Raw HTML headings in Preview (Task 660). Vditor's Preview renders the document with Lute's
// `Md2HTML`, which emits a raw HTML block (or inline HTML that the browser hoists out of its
// paragraph) verbatim, so a top-level `<h2>` can be a raw element. Section indentation treats every
// top-level H1-H6 of the Preview as a section heading, which a raw one is not in IR or WYSIWYG, where
// it is a non-heading `html-block`.
//
// The marker cannot be an id test: Vditor's outline rewrites the id of every top-level Preview
// heading to `<base>_<index>` in `afterRender`, raw ones included. A Lute JS renderer is never
// called by the vendored build either. So, like the HTML-comment mask (editing/html-comment.ts),
// the Preview-only Markdown source gets a `data-vmde-raw-heading` attribute on each raw `<hN` tag,
// which survives Lute's sanitiser. It never reaches the saved Markdown: the saved document is
// serialised from the editor's own DOM, not from this string.

export const RAW_HEADING_ATTR = 'data-vmde-raw-heading'

// Fence open/close: up to 3 leading spaces, then 3+ backticks or tildes (CommonMark).
const FENCE = /^ {0,3}(`{3,}|~{3,})/
// Type-1 HTML blocks (CommonMark): their content is literal up to the closing tag.
const RAW_TEXT_OPEN = /^ {0,3}<(pre|script|style|textarea)(?=[\s>]|$)/i
const MATH_FENCE = /^ {0,3}\$\$\s*$/
const FRONT_MATTER_END = /^(---|\.\.\.)\s*$/
const INDENTED_CODE = /^( {4}|\t)/
const HEADING_TAG = /<(h[1-6])(?=[\s/>])/gi
// Block-quote and list-item prefixes (CommonMark containers). A heading after one is nested, not top
// level, and a fence after one still opens a fence whose content is literal.
const CONTAINER_PREFIX =
  /^(?: {0,3}(?:>|[-*+](?=[ \t]|$)|\d+[.)](?=[ \t]|$))[ \t]?)*/
// A single-line code span (a backtick run, content ending in a non-backtick, the same run) or a
// single-line inline math span (`$` followed and preceded by non-space, not a price like `$5`).
const CODE_SPAN =
  /(`+)([\s\S]*?[^`])\1(?!`)|\$(?=[^\s$])[^$\n]*?[^\s$]\$(?!\d)/g

/** A backslash escapes the tag only when an odd number of them precedes it. */
function isEscaped(text: string, at: number): boolean {
  let slashes = 0
  while (text[at - 1 - slashes] === '\\') slashes++
  return slashes % 2 === 1
}

function markTags(text: string): string {
  return text.replace(HEADING_TAG, (tag, name: string, at: number) =>
    isEscaped(text, at) ? tag : `<${name} ${RAW_HEADING_ATTR}="1"`,
  )
}

/** Marks the `<hN` tags of one line outside its single-line code spans. */
function markLine(line: string): string {
  let out = ''
  let pos = 0
  for (const span of line.matchAll(CODE_SPAN)) {
    out += markTags(line.slice(pos, span.index)) + span[0]
    pos = span.index + span[0].length
  }
  return out + markTags(line.slice(pos))
}

interface ScanState {
  fence: string | null
  rawText: string | null
  math: boolean
}

/** Closes the literal text a `<pre|script|style|textarea>` block opened, or reports it open. */
function inRawText(line: string, state: ScanState): boolean {
  if (state.rawText) {
    if (new RegExp(`</${state.rawText}>`, 'i').test(line)) state.rawText = null
    return true
  }
  const open = RAW_TEXT_OPEN.exec(line)
  if (!open) return false
  if (!new RegExp(`</${open[1]}>`, 'i').test(line)) state.rawText = open[1]
  return true
}

/** Updates the fence state; true when the line is a fence line. */
function toggleFence(line: string, state: ScanState): boolean {
  const f = FENCE.exec(line)
  if (!f) return false
  // Closing fence must be at least as long as the opener and of the same character.
  if (!state.fence) state.fence = f[1]
  else if (f[1][0] === state.fence[0] && f[1].length >= state.fence.length)
    state.fence = null
  return true
}

/** True when the line is literal text (code, math, raw-text block) that must not be rewritten. */
function isLiteralLine(line: string, state: ScanState): boolean {
  if (toggleFence(line, state) || state.fence) return true
  if (MATH_FENCE.test(line)) {
    state.math = !state.math
    return true
  }
  // A line indented 4+ columns is indented code (or a lazy continuation), never a top-level tag.
  return state.math || inRawText(line, state) || INDENTED_CODE.test(line)
}

/** Index of the first line after the leading front matter (0 when there is none). */
function frontMatterEnd(lines: readonly string[]): number {
  if (lines[0].trimEnd() !== '---') return 0
  const end = lines.findIndex((line, i) => i > 0 && FRONT_MATTER_END.test(line))
  return end < 0 ? lines.length : end + 1
}

/**
 * Preview pane ONLY: add `data-vmde-raw-heading="1"` to every raw `<h1>`-`<h6>` open tag in the
 * Markdown source. Text that is not an element is left alone: fenced and indented code, `$$` math
 * blocks, leading front matter, `<pre|script|style|textarea>` blocks, single-line code spans and
 * backslash-escaped tags, inline math, and any line with a quote or list prefix. A line scanner, not a full CommonMark parser (a multi-line code span with
 * a `<hN` on a continuation line would still be marked).
 */
export function markRawHeadingsForPreview(md: string): string {
  if (!/<h[1-6]/i.test(md)) return md
  const lines = md.split('\n')
  const state: ScanState = { fence: null, rawText: null, math: false }
  for (let i = frontMatterEnd(lines); i < lines.length; i++) {
    const line = lines[i]
    const prefix = CONTAINER_PREFIX.exec(line)?.[0] ?? ''
    // The fence, math and raw-text state follows the text after the container prefix; a line that
    // has one is never marked, because a heading in a quote or list item is nested.
    const literal = isLiteralLine(line.slice(prefix.length), state)
    if (!literal && !prefix) lines[i] = markLine(line)
  }
  return lines.join('\n')
}
