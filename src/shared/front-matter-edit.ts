// Task 725 — byte-preserving edit core for the front-matter properties table. Maps the top-level
// entries of the YAML text between the `---` fences to exact source ranges, and edits one entry
// (value, key, remove, move, append) by replacing only that range. Every other byte (comments,
// blank lines, quote styles, indentation, CRLF) stays as it was. Pure: no DOM, no VS Code.
//
// Input convention: `yamlText` is what `frontMatterYaml()` returns, i.e. the text between the
// fences WITHOUT the line break that ends its last line. The last entry therefore usually has no
// final line break (`end === yamlText.length`), and every function here keeps that shape: the
// result also has no trailing line break unless the input had one.
//
// Entries are found with the `yaml` CST (not a clean parse), because empty-key placeholder lines
// (`: ""`) and duplicate keys are errors for `parseDocument` but must stay editable (Task 725 D1,
// D2). Any other parse error, a top level that is not a block map, explicit `?` keys and
// anchored or tagged keys make the whole map `unsupported`.
import { isScalar, Parser, parse, parseDocument } from 'yaml'

export type FrontMatterEntryKind = 'scalar' | 'block' | 'placeholder'

export interface FrontMatterEntry {
  /** Position among the top-level entries. */
  index: number
  /** Decoded key; '' for a placeholder (`: ""`, `:` or `"": …`). */
  key: string
  kind: FrontMatterEntryKind
  /** Another entry has the same non-empty key. */
  duplicate: boolean
  /** Offsets of the entry's lines in yamlText; `end` is after the last line break of the entry. */
  start: number
  end: number
  /** Source range of the key token (quotes included); empty at the `:` for a missing key. */
  keyStart: number
  keyEnd: number
  /**
   * Source range of the value. Scalar: the token on the key line (quotes included, trailing
   * comment excluded; empty and placed right after the `:` when the value is empty). Block: from
   * the first non-blank character after the `:` (or the line break when the value starts on a
   * later line) to the end of the last value token, so a trailing comment stays outside.
   */
  valueStart: number
  valueEnd: number
  /** Editable text: scalar = the decoded string value; block = the exact source of the range. */
  valueText: string
  /**
   * The value is edited as YAML source: always for a block entry, and for a placeholder whose
   * value is not one plain or quoted scalar on the key line (Task 725 UI: it opens the YAML box).
   */
  verbatim: boolean
}

export type FrontMatterEntryMap =
  | { status: 'entries'; entries: FrontMatterEntry[]; eol: '\n' | '\r\n' }
  | { status: 'unsupported'; reason: string }

type QuoteStyle = 'plain' | 'single' | 'double'

/** What the edit functions need beyond the public entry. */
interface ScannedEntry extends FrontMatterEntry {
  keyStyle: QuoteStyle
  valueStyle: QuoteStyle
  valueTyped: boolean
}

type Scan =
  | { status: 'entries'; entries: ScannedEntry[]; eol: '\n' | '\r\n' }
  | { status: 'unsupported'; reason: string }

// Minimal structural view of the `yaml` CST tokens this module reads.
interface Cst {
  type: string
  offset?: number
  source?: string
  start?: unknown
  key?: unknown
  sep?: unknown
  value?: unknown
  items?: unknown
  props?: unknown
  end?: unknown
}

const TRIVIA = new Set(['space', 'newline', 'comment', 'byte-order-mark'])
const ScalarTypes = new Set([
  'scalar',
  'single-quoted-scalar',
  'double-quoted-scalar',
])

function asList(value: unknown): Cst[] {
  return Array.isArray(value) ? (value as Cst[]) : []
}

function asCst(value: unknown): Cst | null {
  return value && typeof value === 'object' ? (value as Cst) : null
}

/** End of a block scalar's header and body; the trailing blank lines of the body belong to no entry. */
function blockScalarEnd(node: Cst): number {
  let end = -1
  let bodyStart = node.offset ?? 0
  for (const prop of asList(node.props)) {
    bodyStart = (prop.offset ?? 0) + (prop.source?.length ?? 0)
    if (!TRIVIA.has(prop.type)) end = Math.max(end, bodyStart)
  }
  const body = (node.source ?? '').trimEnd()
  return body.length > 0 ? Math.max(end, bodyStart + body.length) : end
}

/** End offset of the last non-trivia token inside `token` (-1 when there is none). */
function contentEnd(token: unknown): number {
  const node = asCst(token)
  if (!node) return -1
  if (Array.isArray(token)) {
    return Math.max(-1, ...(token as unknown[]).map(contentEnd))
  }
  if (TRIVIA.has(node.type)) return -1
  if (node.type === 'block-scalar') return blockScalarEnd(node)
  let end = -1
  if (typeof node.source === 'string' && typeof node.offset === 'number') {
    end = node.offset + node.source.length
  }
  const parts = [node.start, node.key, node.sep, node.value, node.items]
  for (const part of [...parts, node.props, node.end]) {
    end = Math.max(end, contentEnd(part))
  }
  return end
}

function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1
}

function lineEndAfter(text: string, offset: number): number {
  const newline = text.indexOf('\n', offset)
  return newline === -1 ? text.length : newline + 1
}

function detectEol(text: string): '\n' | '\r\n' {
  const newline = text.indexOf('\n')
  return newline > 0 && text[newline - 1] === '\r' ? '\r\n' : '\n'
}

function styleOf(token: Cst | null): QuoteStyle {
  if (token?.type === 'single-quoted-scalar') return 'single'
  if (token?.type === 'double-quoted-scalar') return 'double'
  return 'plain'
}

/** Decoded text of a plain or quoted scalar token. */
function decodeScalar(token: Cst): string {
  const source = token.source ?? ''
  if (token.type === 'scalar') return source
  try {
    const decoded: unknown = parse(source)
    if (typeof decoded === 'string') return decoded
  } catch {
    // Falls through to the raw inner text below.
  }
  return source.slice(1, -1)
}

function unsupported(reason: string): Scan {
  return { status: 'unsupported', reason }
}

/** A reason when the item cannot be edited byte-exactly because of what precedes its key. */
function keyPrefixProblem(item: Cst): string | null {
  for (const token of asList(item.start)) {
    if (token.type === 'explicit-key-ind') {
      return 'explicit (?) keys are not supported'
    }
    if (token.type === 'anchor' || token.type === 'tag') {
      return 'anchored or tagged keys are not supported'
    }
  }
  return null
}

interface KeyInfo {
  key: string
  keyStart: number
  keyEnd: number
  keyStyle: QuoteStyle
}

/** The key of an item; a missing key (placeholder) is empty and sits at the `:`. */
function keyInfo(item: Cst, colonOffset: number): KeyInfo | string {
  const token = asCst(item.key)
  if (!token) {
    return {
      key: '',
      keyStart: colonOffset,
      keyEnd: colonOffset,
      keyStyle: 'plain',
    }
  }
  if (!ScalarTypes.has(token.type) || typeof token.offset !== 'number') {
    return 'complex keys are not supported'
  }
  return {
    key: decodeScalar(token),
    keyStart: token.offset,
    keyEnd: token.offset + (token.source?.length ?? 0),
    keyStyle: styleOf(token),
  }
}

interface ValueInfo {
  valueStart: number
  valueEnd: number
  valueText: string
  valueStyle: QuoteStyle
  /** A plain value that is not a string (number, boolean, null, empty): see `formatScalar`. */
  valueTyped: boolean
}

/** True when a plain scalar's source does not resolve to a string (`3`, `true`, `~`). */
function plainIsTyped(source: string): boolean {
  try {
    return typeof parse(source) !== 'string'
  } catch {
    return false
  }
}

function textualValue(valueToken: Cst | null, colonEnd: number): ValueInfo {
  if (!valueToken || typeof valueToken.offset !== 'number') {
    return {
      valueStart: colonEnd,
      valueEnd: colonEnd,
      valueText: '',
      valueStyle: 'plain',
      valueTyped: true,
    }
  }
  const valueStyle = styleOf(valueToken)
  return {
    valueStart: valueToken.offset,
    valueEnd: valueToken.offset + (valueToken.source?.length ?? 0),
    valueText: decodeScalar(valueToken),
    valueStyle,
    valueTyped: valueStyle === 'plain' && plainIsTyped(valueToken.source ?? ''),
  }
}

function blockValue(text: string, colonEnd: number, last: number): ValueInfo {
  let valueStart = colonEnd
  while (text[valueStart] === ' ' || text[valueStart] === '\t') valueStart += 1
  const valueEnd = Math.max(last, valueStart)
  return {
    valueStart,
    valueEnd,
    valueText: text.slice(valueStart, valueEnd),
    valueStyle: 'plain',
    valueTyped: false,
  }
}

function scanEntry(
  text: string,
  index: number,
  item: Cst,
): ScannedEntry | string {
  const problem = keyPrefixProblem(item)
  if (problem) return problem
  const sep = asList(item.sep)
  const colon = sep.find((token) => token.type === 'map-value-ind')
  if (!colon || typeof colon.offset !== 'number') {
    return 'a key without a value indicator'
  }
  const colonEnd = colon.offset + 1
  const keyed = keyInfo(item, colon.offset)
  if (typeof keyed === 'string') return keyed
  const valueToken = asCst(item.value)
  const last = Math.max(contentEnd(item), colonEnd)
  const hasProps = sep.some(
    (token) => token.type === 'anchor' || token.type === 'tag',
  )
  const singleLine = !text.slice(colonEnd, last).includes('\n')
  const scalarOrEmpty = valueToken === null || ScalarTypes.has(valueToken.type)
  // A value that is empty, or one plain/quoted scalar on the key line, edits as text.
  const textual = !hasProps && singleLine && scalarOrEmpty
  const kind: FrontMatterEntryKind =
    keyed.key === '' ? 'placeholder' : textual ? 'scalar' : 'block'
  const value = textual
    ? textualValue(valueToken, colonEnd)
    : blockValue(text, colonEnd, last)
  return {
    index,
    kind,
    duplicate: false,
    start: lineStartOf(text, keyed.keyStart),
    end: lineEndAfter(text, last),
    verbatim: !textual,
    ...keyed,
    ...value,
  }
}

/** The top-level block map of the text (null when there is no content), or the reason it is not editable. */
function topBlockMap(yamlText: string): Cst | null | string {
  let top: Cst | null = null
  for (const token of new Parser().parse(yamlText) as Iterable<Cst>) {
    if (TRIVIA.has(token.type)) continue
    if (token.type !== 'document' || top) {
      return 'front matter has more than one document or a directive'
    }
    top = asCst(token.value)
    if (!top && contentEnd(token) >= 0)
      return 'front matter is not a key: value map'
  }
  if (top && top.type !== 'block-map')
    return 'front matter is not a key: value map'
  return top
}

function markDuplicates(entries: ScannedEntry[]): void {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
  }
  for (const entry of entries) {
    entry.duplicate = entry.key !== '' && (counts.get(entry.key) ?? 0) > 1
  }
}

function scan(yamlText: string): Scan {
  const document = parseDocument(yamlText, { prettyErrors: false })
  // Duplicate keys (several `: ""` placeholders included) are the only errors that stay editable.
  const fatal = document.errors.find((error) => error.code !== 'DUPLICATE_KEY')
  if (fatal) return unsupported(fatal.message)
  const top = topBlockMap(yamlText)
  if (typeof top === 'string') return unsupported(top)
  const eol = detectEol(yamlText)
  const entries: ScannedEntry[] = []
  for (const item of top ? asList(top.items) : []) {
    const entry = scanEntry(yamlText, entries.length, item)
    if (typeof entry === 'string') return unsupported(entry)
    entries.push(entry)
  }
  markDuplicates(entries)
  return { status: 'entries', entries, eol }
}

export function mapFrontMatterEntries(yamlText: string): FrontMatterEntryMap {
  const result = scan(yamlText)
  if (result.status === 'unsupported') return result
  return {
    status: 'entries',
    eol: result.eol,
    entries: result.entries.map((entry) => ({
      index: entry.index,
      key: entry.key,
      kind: entry.kind,
      duplicate: entry.duplicate,
      start: entry.start,
      end: entry.end,
      keyStart: entry.keyStart,
      keyEnd: entry.keyEnd,
      valueStart: entry.valueStart,
      valueEnd: entry.valueEnd,
      valueText: entry.valueText,
      verbatim: entry.verbatim,
    })),
  }
}

// --- Scalar quoting -----------------------------------------------------------------------------

// Characters a plain or single-quoted scalar cannot carry on one line (control characters, line
// separators, the byte-order mark). Double quotes escape them.
function needsEscape(text: string): boolean {
  for (let position = 0; position < text.length; position += 1) {
    const code = text.charCodeAt(position)
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0xfeff
    ) {
      return true
    }
  }
  return false
}
const OnlyDoubleEscape = /[\u007f-\u009f\u2028\u2029\ufeff]/g

function doubleQuote(text: string): string {
  return JSON.stringify(text).replace(
    OnlyDoubleEscape,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

function singleQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/** True when `candidate` as a value reads back, with `yaml`, as the string `text`. */
function valueReadsBack(candidate: string, text: string): boolean {
  const document = parseDocument(`k: ${candidate}`, { prettyErrors: false })
  if (document.errors.length > 0) return false
  const value: unknown = document.get('k')
  return typeof value === 'string' && value === text
}

/** True when `candidate` as a key reads back, with `yaml`, as the string `text`. */
function keyReadsBack(candidate: string, text: string): boolean {
  const document = parseDocument(`${candidate}: x`, { prettyErrors: false })
  if (document.errors.length > 0) return false
  const contents = document.contents as {
    items?: { key?: { value?: unknown } | null }[]
  } | null
  const items = contents?.items
  if (items?.length !== 1) return false
  const keyValue = items[0]?.key?.value
  return typeof keyValue === 'string' && keyValue === text
}

/** True when `candidate` as a value is exactly one plain scalar of any type (`4`, `true`, `x`). */
function plainValueReadsBack(candidate: string): boolean {
  const document = parseDocument(`k: ${candidate}`, { prettyErrors: false })
  if (document.errors.length > 0) return false
  const items = (document.contents as { items?: { value?: unknown }[] } | null)
    ?.items
  const value = items?.length === 1 ? items[0]?.value : null
  return (
    isScalar(value) &&
    value.type === 'PLAIN' &&
    value.range?.[0] === 3 &&
    value.range?.[1] === 3 + candidate.length
  )
}

/**
 * Source for `text` as a scalar. The original quote style is kept (re-escaped); a plain scalar
 * stays plain only when the new text reads back as the same string, otherwise it is double-quoted.
 * A `typed` plain value (number, boolean, null, empty) also stays plain when the new text is one
 * plain scalar of any type, so `count: 3` edited to `4` stays a number (Task 725 UI). Empty text is
 * always `""`.
 */
function formatScalar(
  text: string,
  style: QuoteStyle,
  readsBack: (candidate: string, text: string) => boolean,
  typed = false,
): string {
  if (text === '') return '""'
  if (style === 'single' && !needsEscape(text)) {
    const candidate = singleQuote(text)
    if (readsBack(candidate, text)) return candidate
  }
  if (
    style === 'plain' &&
    !needsEscape(text) &&
    (readsBack(text, text) || (typed && plainValueReadsBack(text)))
  ) {
    return text
  }
  return doubleQuote(text)
}

// --- Edits --------------------------------------------------------------------------------------

function entryAt(
  yamlText: string,
  index: number,
): { entry: ScannedEntry; entries: ScannedEntry[]; eol: '\n' | '\r\n' } | null {
  const result = scan(yamlText)
  if (result.status !== 'entries') return null
  const entry = result.entries[index]
  if (!entry || !Number.isInteger(index)) return null
  return { entry, entries: result.entries, eol: result.eol }
}

function splice(text: string, start: number, end: number, insert: string) {
  return text.slice(0, start) + insert + text.slice(end)
}

/**
 * Replaces the value of entry `index`. A scalar keeps its quote style (see `formatScalar`). A
 * block value (list, map, block scalar, flow collection, multi-line text, alias, anchored or
 * tagged value) is written verbatim as the new value source; line breaks are converted to the
 * document's own. The caller sends YAML source there, and when the result no longer parses as
 * that entry it is still written (the table shows the malformed-YAML warning).
 */
export function editFrontMatterValue(
  yamlText: string,
  index: number,
  text: string,
): string | null {
  const found = entryAt(yamlText, index)
  if (!found) return null
  const { entry, eol } = found
  if (entry.verbatim) {
    return splice(
      yamlText,
      entry.valueStart,
      entry.valueEnd,
      text.replace(/\r?\n/g, eol),
    )
  }
  const source = formatScalar(
    text,
    entry.valueStyle,
    valueReadsBack,
    entry.valueTyped,
  )
  // An empty value has no token: the new one goes right after the `:` behind a space.
  const insert = entry.valueStart === entry.valueEnd ? ` ${source}` : source
  return splice(yamlText, entry.valueStart, entry.valueEnd, insert)
}

/**
 * Renames the key of entry `index`, keeping the value bytes. A key that another entry already has
 * is written as typed (Task 725 D2); both entries then map with `duplicate: true`. A placeholder
 * has no key token, so the key is inserted in front of its `:`.
 */
export function renameFrontMatterKey(
  yamlText: string,
  index: number,
  key: string,
): string | null {
  const found = entryAt(yamlText, index)
  if (!found) return null
  const { entry } = found
  return splice(
    yamlText,
    entry.keyStart,
    entry.keyEnd,
    formatScalar(key, entry.keyStyle, keyReadsBack),
  )
}

/**
 * Deletes the lines of entry `index` only; comment and blank lines around it stay. The last entry
 * has no final line break, so the line break before it goes too and the text keeps its
 * no-trailing-line-break shape (Task 725 D3).
 */
export function removeFrontMatterEntry(
  yamlText: string,
  index: number,
): string | null {
  const found = entryAt(yamlText, index)
  if (!found) return null
  const { entry } = found
  let { start } = entry
  if (entry.end === yamlText.length && !/\n$/.test(yamlText) && start > 0) {
    start -= yamlText[start - 2] === '\r' ? 2 : 1
  }
  return splice(yamlText, start, entry.end, '')
}

/**
 * Swaps the line ranges of entry `index` and its neighbour (`delta` -1 = up, +1 = down). Comment
 * and blank lines between the two stay where they are, so a comment above an entry does not move
 * with it (Task 725 D4, provisional). Null when the neighbour does not exist.
 */
export function moveFrontMatterEntry(
  yamlText: string,
  index: number,
  delta: -1 | 1,
): string | null {
  const found = entryAt(yamlText, index)
  if (!found) return null
  const { entries, eol } = found
  const neighbour = entries[index + delta]
  if (!neighbour) return null
  const first = delta < 0 ? neighbour : entries[index]
  const second = delta < 0 ? entries[index] : neighbour
  if (!first || !second) return null
  let firstText = yamlText.slice(first.start, first.end)
  let secondText = yamlText.slice(second.start, second.end)
  // The last entry may lack its line break; the entry that becomes last gives its break to the other.
  if (!/\n$/.test(secondText)) {
    secondText += eol
    firstText = firstText.replace(/\r?\n$/, '')
  }
  return (
    yamlText.slice(0, first.start) +
    secondText +
    yamlText.slice(first.end, second.start) +
    firstText +
    yamlText.slice(second.end)
  )
}

/**
 * Appends the line `: ""` (an empty-key placeholder, Task 725 D1) as the last line. Repeated calls
 * add several lines. The result keeps the shape of the input: no trailing line break when the
 * input had none (the `frontMatterYaml()` convention), one when it had one (Task 725 D3).
 */
export function appendFrontMatterPlaceholder(yamlText: string): string {
  const eol = detectEol(yamlText)
  if (yamlText === '') return ': ""'
  if (yamlText.endsWith('\n')) return `${yamlText}: ""${eol}`
  return `${yamlText}${eol}: ""`
}
