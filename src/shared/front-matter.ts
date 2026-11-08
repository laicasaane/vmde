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
