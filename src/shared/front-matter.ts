// Task 207 — pure front-matter properties model. Turns the YAML text between the `---` lines into
// the rows the webview renders as a two-column properties table (D2 display and copy rules, D3
// warnings). Shared so the host can reuse the same `yaml` parse for `aliases:`/`tags:` later; the
// eager webview module imports it with `import type` only, because the parser (~95 KB) ships in
// the lazy `front-matter-main.js` bundle.
import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Node as YamlNode,
  type Scalar,
} from 'yaml'
import { normalizeWikiLookupKey } from './wiki-core'

export type FrontMatterValueView =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: FrontMatterValueView[] }
  | { kind: 'map'; rows: { key: string; value: FrontMatterValueView }[] }

export interface FrontMatterRow {
  key: string
  value: FrontMatterValueView
  keyCopy: string
  valueCopy: string
}

export type FrontMatterParseResult =
  | { status: 'table'; rows: FrontMatterRow[] }
  | { status: 'empty' }
  | { status: 'error'; warning: string }

/** Values nested deeper than this show their YAML source as text instead of a nested view. */
export const FRONT_MATTER_NESTING_LIMIT = 4

const WARNING_PREFIX = 'Front matter could not be parsed: '

interface Context {
  source: string
  lines: LineCounter
}

type Range = [number, number, number]

function rangeOf(node: unknown): Range | null {
  const range = (node as { range?: Range | null } | null | undefined)?.range
  return range ?? null
}

function sourceSlice(context: Context, node: unknown): string {
  const range = rangeOf(node)
  return range ? context.source.slice(range[0], range[1]).trimEnd() : ''
}

/** Removes the indentation shared by every non-blank line. */
function dedent(lines: string[]): string[] {
  let common = Number.POSITIVE_INFINITY
  for (const line of lines) {
    if (line.trim() === '') continue
    common = Math.min(common, line.length - line.trimStart().length)
  }
  if (!Number.isFinite(common) || common === 0) return lines
  return lines.map((line) => line.slice(Math.min(common, line.length)))
}

function blockScalarText(context: Context, node: Scalar): string {
  if (node.type === 'BLOCK_LITERAL') {
    return String(node.value ?? '').replace(/\n+$/, '')
  }
  // Folded: keep the body lines as written (D2), dropping the `>` header line.
  const range = rangeOf(node)
  if (!range) return String(node.value ?? '').replace(/\n+$/, '')
  const body = context.source.slice(range[0], range[1]).split('\n').slice(1)
  return dedent(body).join('\n').replace(/\n+$/, '')
}

function scalarText(context: Context, node: Scalar): string {
  if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') {
    return blockScalarText(context, node)
  }
  if (node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE') {
    return String(node.value ?? '')
  }
  // PLAIN keeps its literal source (`1.0`, `true`, `null`, `2024-01-02` stay as written).
  return node.source ?? String(node.value ?? '')
}

function viewOf(
  context: Context,
  node: unknown,
  depth: number,
): FrontMatterValueView {
  if (node === null || node === undefined) return { kind: 'text', text: '' }
  // `Alias.source` is the anchor name only; the source slice keeps the `*` (D2: alias = source text).
  if (isAlias(node)) return { kind: 'text', text: sourceSlice(context, node) }
  if (isScalar(node)) return { kind: 'text', text: scalarText(context, node) }
  if (depth > FRONT_MATTER_NESTING_LIMIT) {
    return { kind: 'text', text: sourceSlice(context, node) }
  }
  if (isSeq(node)) {
    return {
      kind: 'list',
      items: node.items.map((item) => viewOf(context, item, depth + 1)),
    }
  }
  if (isMap(node)) {
    return {
      kind: 'map',
      rows: node.items.map((pair) => ({
        key: keyText(context, pair.key),
        value: viewOf(context, pair.value, depth + 1),
      })),
    }
  }
  return { kind: 'text', text: sourceSlice(context, node) }
}

function keyText(context: Context, key: unknown): string {
  if (isScalar(key)) return scalarText(context, key)
  return sourceSlice(context, key)
}

/**
 * The YAML source of a list or map value. A value that starts on the key's line (flow style) is
 * the exact slice; a block value is its full source lines with the common indentation removed.
 */
function collectionSource(
  context: Context,
  value: YamlNode,
  keyNode: unknown,
): string {
  const range = rangeOf(value)
  if (!range) return ''
  const keyRange = rangeOf(keyNode)
  const valueLine = context.lines.linePos(range[0]).line
  const keyLine = keyRange ? context.lines.linePos(keyRange[0]).line : valueLine
  if (valueLine === keyLine)
    return context.source.slice(range[0], range[1]).trimEnd()
  const lineStart = context.lines.lineStarts[valueLine - 1] ?? range[0]
  const lines = context.source.slice(lineStart, range[1]).split('\n')
  return dedent(lines).join('\n').trimEnd()
}

function rowOf(context: Context, pair: unknown): FrontMatterRow {
  const { key, value } = pair as { key: unknown; value: unknown }
  const keyDisplay = keyText(context, key)
  const view = viewOf(context, value, 1)
  const valueCopy =
    view.kind === 'text'
      ? view.text
      : collectionSource(context, value as YamlNode, key)
  return { key: keyDisplay, value: view, keyCopy: keyDisplay, valueCopy }
}

export function parseFrontMatterProperties(
  yamlText: string,
): FrontMatterParseResult {
  const lines = new LineCounter()
  const document = parseDocument(yamlText, {
    prettyErrors: false,
    lineCounter: lines,
  })
  const [first] = document.errors
  if (first) {
    // The document line counts the opening `---` line, so the yaml line is shifted by one.
    const { line, col } = lines.linePos(first.pos[0])
    return {
      status: 'error',
      warning: `${WARNING_PREFIX}${first.message} (line ${line + 1}, column ${col})`,
    }
  }
  const top = document.contents
  if (top === null || (isMap(top) && top.items.length === 0)) {
    return { status: 'empty' }
  }
  if (!isMap(top)) {
    return {
      status: 'error',
      warning: `${WARNING_PREFIX}expected key: value properties`,
    }
  }
  const context: Context = { source: yamlText, lines }
  return {
    status: 'table',
    rows: top.items.filter(isPair).map((pair) => rowOf(context, pair)),
  }
}

// Task 709 — host-side metadata: `aliases:` and `tags:` of the leading front-matter block. The wiki
// cache reads only the head of each page, so the block locator works on a string that may end
// before the closing fence.

export interface FrontMatterMetadata {
  aliases: string[]
  tags: string[]
}

/** Upper bounds per file; extra entries are ignored. */
export const FRONT_MATTER_ALIAS_LIMIT = 64
export const FRONT_MATTER_TAG_LIMIT = 256

const OpeningFence = /^\uFEFF?---[ \t]*\r?\n/
const ClosingFence = /^---[ \t]*$/

/** True when `markdown` starts with an opening fence (used to decide whether to read more bytes). */
export function startsWithFrontMatterFence(markdown: string): boolean {
  return OpeningFence.test(markdown)
}

/**
 * The YAML text of the leading front-matter block, or null when `markdown` does not start with
 * one or the block is not closed in the given text.
 */
export function frontMatterYaml(markdown: string): string | null {
  const opening = OpeningFence.exec(markdown)
  if (!opening) return null
  const start = opening[0].length
  let lineStart = start
  while (lineStart <= markdown.length) {
    const newline = markdown.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? markdown.length : newline
    const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (ClosingFence.test(line)) {
      // The text between the fences, without the line break that ends its last line.
      return markdown.slice(start, lineStart).replace(/\r?\n$/, '')
    }
    if (newline === -1) return null
    lineStart = newline + 1
  }
  return null
}

// An alias that can never be written inside `[[…]]` (`[`, `]`, `|` start or end the link, a line
// break splits it) or whose lookup key is empty is dropped.
const UnwritableAlias = /[[\]|\n\r]/

// Reads the scalar entries of a scalar or sequence value through `accept` (it returns the cleaned
// entry or null to drop it) until `limit` entries are kept. Non-scalar items are skipped.
function entriesOf(
  context: Context,
  node: unknown,
  accept: (text: string) => string | null,
  limit: number,
  out: string[],
): void {
  const add = (item: unknown) => {
    if (out.length >= limit || !isScalar(item) || item.value === null) return
    const accepted = accept(scalarText(context, item).trim())
    if (accepted === null) return
    out.push(accepted)
  }
  if (isSeq(node)) {
    for (const item of node.items) add(item)
  } else {
    add(node)
  }
}

/**
 * `aliases` and `tags` of a front-matter YAML text. Null when the YAML has an error, the top level
 * is not a map, or neither key gives a usable value. Never throws.
 */
export function readFrontMatterMetadata(
  yamlText: string,
): FrontMatterMetadata | null {
  try {
    const document = parseDocument(yamlText, { prettyErrors: false })
    if (document.errors.length > 0) return null
    const top = document.contents
    if (!isMap(top)) return null
    let aliasNode: unknown
    let tagNode: unknown
    for (const pair of top.items) {
      if (!isScalar(pair.key)) continue
      if (pair.key.value === 'aliases') aliasNode = pair.value
      else if (pair.key.value === 'tags') tagNode = pair.value
    }
    if (aliasNode === undefined && tagNode === undefined) return null
    // Allocation happens only for pages that declare one of the two keys.
    const context: Context = { source: yamlText, lines: new LineCounter() }
    const aliases: string[] = []
    const aliasKeys = new Set<string>()
    entriesOf(
      context,
      aliasNode,
      (text) => {
        if (!text || UnwritableAlias.test(text)) return null
        const key = normalizeWikiLookupKey(text)
        if (!key || aliasKeys.has(key)) return null
        aliasKeys.add(key)
        return text
      },
      FRONT_MATTER_ALIAS_LIMIT,
      aliases,
    )
    const tags: string[] = []
    const tagKeys = new Set<string>()
    entriesOf(
      context,
      tagNode,
      (text) => {
        const tag = (text.startsWith('#') ? text.slice(1) : text).trim()
        const key = tag.toLowerCase()
        if (!tag || tagKeys.has(key)) return null
        tagKeys.add(key)
        return tag
      },
      FRONT_MATTER_TAG_LIMIT,
      tags,
    )
    if (aliases.length === 0 && tags.length === 0) return null
    return { aliases, tags }
  } catch {
    return null
  }
}
