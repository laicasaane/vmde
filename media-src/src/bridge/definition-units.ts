import {
  type MovableBlock,
  type MovableKind,
  scanMovableBlocks,
} from '../../../src/shared/block-move'
import type { UnitSpinResult } from '../editing/unit-spin'
import { domKind } from '../nav/unit-pairing'
import { DEFINITION_UNITS, type DefinitionContext } from '../util/unit-changes'

// Task 733 / 017 (task 017 sections 6.2 to 6.4): the model-only kinds `definition` (one link reference
// definition line), `footnote` (one footnote definition) and `toc` (a table of contents). The text
// model scans and lists them so a document with definitions keeps the model live. Everything here is
// pure string or detached-DOM work; with the guard off every function answers today's result.

// The Lute shapes used here, declared structurally: `unit-lute` imports this module's strip.
interface SpinLute {
  SpinVditorIRDOM(html: string): string
}
interface UnitLute {
  VditorIRDOM2Md(html: string): string
}

export interface ModelScanOptions {
  /** The ToC option is on: a `[toc]` line renders as a table of contents. */
  readonly toc: boolean
  /** Default DEFINITION_UNITS. */
  readonly definitionUnits?: boolean
}

export interface FootnoteInfo {
  /** 1-based position of the definition among the document's footnote definitions (Lute's number). */
  readonly number: number
  /** The definition's text as Lute writes it into the reference's `aria-label`. */
  readonly tooltip: string
}

/** The start of a link reference definition line (not a footnote): `   [label]:`. */
const DEFINITION_START = /^ {0,3}\[(?!\^)((?:[^\]\\\n]|\\.)+)\]:/u
/** A complete single-line definition: destination and an optional title on the same line. */
const DEFINITION_LINE =
  /^ {0,3}\[(?!\^)(?:[^\]\\\n]|\\.)+\]:[ \t]*\S+(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/u
/** The start of a footnote definition: `   [^label]:`. */
const FOOTNOTE_START = /^ {0,3}\[\^([^\]\n]+)\]:/u
/** A line that continues a definition's title (CommonMark allows the title on the next line). */
const TITLE_CONTINUATION = /^[ \t]*["'(]/u
const TOC_LINE = /^ {0,3}\[toc\][ \t]*$/iu
/** Leading quote and list markers of a line inside an item or a quote. */
const CONTAINER_PREFIX = /^(?:[ \t]*(?:>|[-*+]|\d{1,9}[.)])(?=[ \t]|$))*[ \t]*/u

const DECLINED: MovableBlock[] = []

interface Line {
  readonly start: number
  readonly end: number
  readonly text: string
}

function linesIn(text: string, start: number, end: number): Line[] {
  const lines: Line[] = []
  let at = start
  while (at <= end) {
    let next = text.indexOf('\n', at)
    if (next < 0 || next > end) next = end
    lines.push({ start: at, end: next, text: text.slice(at, next) })
    at = next + 1
  }
  return lines
}

const block = (
  kind: MovableKind,
  start: number,
  end: number,
): MovableBlock => ({
  kind,
  start,
  end,
  sectionEnd: 0,
  listRun: -1,
})

/** True when a line inside a list item or a quote starts a definition or a footnote definition. */
function holdsNestedDefinition(text: string, b: MovableBlock): boolean {
  for (const line of linesIn(text, b.start, b.end)) {
    const bare = line.text.replace(CONTAINER_PREFIX, '')
    if (DEFINITION_START.test(bare) || FOOTNOTE_START.test(bare)) return true
  }
  return false
}

/** One `footnote` block per footnote definition of a paragraph (no blank line between them). */
function footnoteBlocks(
  lines: readonly Line[],
  b: MovableBlock,
): MovableBlock[] {
  const out: MovableBlock[] = []
  let start = b.start
  for (let i = 1; i < lines.length; i++) {
    if (!FOOTNOTE_START.test(lines[i].text)) continue
    out.push(block('footnote', start, lines[i - 1].end))
    start = lines[i].start
  }
  out.push(block('footnote', start, b.end))
  return out
}

/** True when a line from `from` on starts a footnote definition (one cannot follow paragraph text). */
function footnoteAfter(lines: readonly Line[], from: number): boolean {
  for (let i = from; i < lines.length; i++)
    if (FOOTNOTE_START.test(lines[i].text)) return true
  return false
}

/**
 * The leading definition lines of a paragraph, then the rest as a paragraph of its own (a definition
 * cannot interrupt a paragraph). undefined: a definition that continues on the next line.
 */
function definitionBlocks(
  lines: readonly Line[],
  b: MovableBlock,
): MovableBlock[] | undefined {
  const out: MovableBlock[] = []
  let i = 0
  for (; i < lines.length && DEFINITION_START.test(lines[i].text); i++) {
    const next = lines[i + 1]
    if (
      !DEFINITION_LINE.test(lines[i].text) ||
      (next && TITLE_CONTINUATION.test(next.text))
    )
      return undefined
    out.push(block('definition', lines[i].start, lines[i].end))
  }
  if (i === lines.length) return out
  if (footnoteAfter(lines, i + 1)) return undefined
  out.push(block('paragraph', lines[i].start, b.end))
  return out
}

/**
 * The blocks of one scanner paragraph: definition lines, footnote definitions, a `[toc]` line, or the
 * paragraph itself. undefined: a construct the model declines (a definition that continues on the next
 * line, a footnote definition after paragraph text).
 */
function paragraphBlocks(
  text: string,
  b: MovableBlock,
  toc: boolean,
): MovableBlock[] | undefined {
  const lines = linesIn(text, b.start, b.end)
  const first = lines[0].text
  if (toc && lines.length === 1 && TOC_LINE.test(first))
    return [block('toc', b.start, b.end)]
  if (FOOTNOTE_START.test(first)) return footnoteBlocks(lines, b)
  if (DEFINITION_START.test(first)) return definitionBlocks(lines, b)
  return footnoteAfter(lines, 1) ? undefined : [b]
}

/** The model blocks of one scanner block; undefined when the model declines it. */
function modelBlocksOf(
  text: string,
  b: MovableBlock,
  toc: boolean,
): readonly MovableBlock[] | undefined {
  if (b.kind === 'list-item' || b.kind === 'quote')
    return holdsNestedDefinition(text, b) ? undefined : [b]
  return b.kind === 'paragraph' ? paragraphBlocks(text, b, toc) : [b]
}

/** `scanMovableBlocks` plus the model-only kinds; [] when the document holds a construct the model declines. */
export function scanModelBlocks(
  text: string,
  options: ModelScanOptions,
): MovableBlock[] {
  const blocks = scanMovableBlocks(text)
  if (!(options.definitionUnits ?? DEFINITION_UNITS) || blocks.length === 0)
    return blocks
  // Most documents hold no bracket followed by a colon or a toc line: the scan stays as it is.
  if (!text.includes(']:') && !(options.toc && /\[toc\]/iu.test(text)))
    return blocks
  const out: MovableBlock[] = []
  for (const b of blocks) {
    const parts = modelBlocksOf(text, b, options.toc)
    if (!parts) return DECLINED
    out.push(...parts)
  }
  for (let i = 0; i < out.length; i++)
    out[i].sectionEnd = out[i + 1]?.start ?? text.length
  return out
}

/** `domKind` plus the model-only kinds of a definitions div holding one line, a footnote definition and a TOC. */
export function unitKindOf(
  element: HTMLElement,
  definitionUnits: boolean = DEFINITION_UNITS,
): MovableKind | null {
  if (!definitionUnits) return domKind(element)
  const type = element.getAttribute('data-type')
  if (type === 'link-ref-defs-block') {
    const body = (element.textContent ?? '').replace(/\n+$/u, '')
    return body.includes('\n') || !DEFINITION_START.test(body)
      ? null
      : 'definition'
  }
  if (type === 'footnotes-def') return 'footnote'
  if (type === 'toc-block') return 'toc'
  return domKind(element)
}

/** CommonMark-like label normalization: trimmed, inner white space collapsed, case folded (OQ-5). */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/gu, ' ').toUpperCase().toLowerCase()
}

const BRACKET = /\[((?:[^[\]\\\n]|\\.)+)\]/gu

/** Normalized link and footnote labels `source` may reference; undefined when it holds no bracket pair. */
export function referencedLabels(
  source: string,
):
  | { readonly links: readonly string[]; readonly footnotes: readonly string[] }
  | undefined {
  if (!source.includes('[')) return undefined
  let links: string[] | undefined
  let footnotes: string[] | undefined
  for (const match of source.matchAll(BRACKET)) {
    const raw = match[1]
    if (raw.startsWith('^')) footnotes = addLabel(footnotes, raw.slice(1))
    else links = addLabel(links, raw)
  }
  if (!links && !footnotes) return undefined
  return { links: links ?? [], footnotes: footnotes ?? [] }
}

/** Adds the normalized `raw` to `labels` once; creates the list on first use. */
function addLabel(labels: string[] | undefined, raw: string): string[] {
  const out = labels ?? []
  const label = normalizeLabel(raw)
  if (label && !out.includes(label)) out.push(label)
  return out
}

/** The label of a definition line, or undefined. */
export function definitionLabelOf(source: string): string | undefined {
  const match = DEFINITION_START.exec(source)
  return match ? normalizeLabel(match[1]) : undefined
}

/** The label and tooltip of a footnote definition source, or undefined. */
export function footnoteOfSource(
  source: string,
): { readonly label: string; readonly tooltip: string } | undefined {
  const match = FOOTNOTE_START.exec(source)
  if (!match) return undefined
  const body = source.slice(match[0].length)
  // Lute joins the definition's lines without a separator for the reference's `aria-label`.
  const tooltip = body
    .split('\n')
    .map((line) => line.trim())
    .join('')
  return { label: normalizeLabel(match[1]), tooltip }
}

const SHAPE: UnitSpinResult = { kind: 'refused', reason: 'shape' }
const DEFINITION_DIV =
  /^<div data-block="0" data-type="link-ref-defs-block">([^<]*(?:<wbr>[^<]*)?)<\/div>$/u

/**
 * Spins one definitions div alone; `shape` unless the result is one div holding one definition line.
 */
export function spinDefinitionHtml(
  lute: SpinLute,
  defOuterHtml: string,
): UnitSpinResult {
  let out: string
  try {
    out = lute.SpinVditorIRDOM(defOuterHtml)
  } catch {
    return SHAPE
  }
  const match = DEFINITION_DIV.exec(out)
  if (!match) return SHAPE
  const body = match[1].replace('<wbr>', '').replace(/\n+$/u, '')
  if (body.includes('\n') || !DEFINITION_START.test(body)) return SHAPE
  return { kind: 'spun', html: out }
}

function parse(html: string): HTMLTemplateElement {
  const template = document.createElement('template')
  template.innerHTML = html
  return template
}

/**
 * Spins one footnote definition in its block shell; `shape` unless one block with one definition comes back.
 */
export function spinFootnoteHtml(
  lute: SpinLute,
  shellOpenTag: string,
  defOuterHtml: string,
  context?: DefinitionContext,
): UnitSpinResult {
  let out: string | undefined
  try {
    out = lute.SpinVditorIRDOM(
      `${shellOpenTag}${defOuterHtml}</div>${context?.html ?? ''}`,
    )
  } catch {
    return SHAPE
  }
  if (context) out = stripDefinitionContext(out, context, () => undefined)
  if (out === undefined) return SHAPE
  const top = parse(out).content.children
  if (
    top.length !== 1 ||
    top[0].getAttribute('data-type') !== 'footnotes-block'
  )
    return SHAPE
  const defs = top[0].children
  if (
    defs.length !== 1 ||
    defs[0].getAttribute('data-type') !== 'footnotes-def'
  )
    return SHAPE
  return { kind: 'spun', html: defs[0].outerHTML }
}

/** The canon of one footnote definition: serialized alone in its block shell (fact 5). */
export function serializeFootnoteHtml(
  lute: UnitLute,
  shellOpenTag: string,
  defOuterHtml: string,
): string {
  return lute
    .VditorIRDOM2Md(`${shellOpenTag}${defOuterHtml}</div>`)
    .replace(/\n+$/u, '')
}

/** Text of the sentinel paragraph that starts a definition context; Lute keeps it as a plain paragraph. */
const SENTINEL_TEXT = 'VMDEDEFINITIONCONTEXTSENTINEL'
const CONTEXT_SENTINEL = `<p data-block="0">${SENTINEL_TEXT}</p>`

/** A context from the outerHTML of live definition and footnote definition elements; undefined for none. */
export function definitionContextOf(
  definitions: readonly string[],
  footnotes: readonly string[],
): DefinitionContext | undefined {
  if (definitions.length === 0 && footnotes.length === 0) return undefined
  // Definitions first, then one footnotes block: the order Lute's spin leaves them in (6.12).
  const notes = footnotes.length
    ? `<div data-block="0" data-type="footnotes-block">${footnotes.join('')}</div>`
    : ''
  return {
    html: `${CONTEXT_SENTINEL}${definitions.join('')}${notes}`,
    blocks: definitions.length + (footnotes.length ? 1 : 0),
  }
}

const normalizedText = (el: Element): string =>
  (el.textContent ?? '').replace(/\s+/gu, '')

/**
 * The spin result without its context: everything from the sentinel paragraph on is removed after it is
 * checked against `context` (same block count, same texts). undefined: the result mixed the unit's own
 * blocks with the context (a definition typed into the unit), so the caller spins again without one.
 * Footnote references keep the document's numbers and tooltips from `footnoteOf`.
 */
export function stripDefinitionContext(
  html: string,
  context: DefinitionContext,
  footnoteOf: (label: string) => FootnoteInfo | undefined,
): string | undefined {
  const at = html.indexOf(`<p data-block="0">${SENTINEL_TEXT}`)
  if (at < 0) return undefined
  const sentinelEnd = html.indexOf('</p>', at)
  if (sentinelEnd < 0) return undefined
  const tail = parse(html.slice(sentinelEnd + 4)).content.children
  const expected = parse(context.html.slice(CONTEXT_SENTINEL.length)).content
    .children
  if (tail.length !== context.blocks || expected.length !== context.blocks)
    return undefined
  for (let i = 0; i < tail.length; i++)
    if (normalizedText(tail[i]) !== normalizedText(expected[i]))
      return undefined
  const head = html.slice(0, at)
  if (!head.includes('footnotes-ref')) return head
  const template = parse(head)
  for (const sup of template.content.querySelectorAll<HTMLElement>(
    'sup[data-type="footnotes-ref"]',
  )) {
    const label = (sup.getAttribute('data-footnotes-label') ?? '').replace(
      /^\^/u,
      '',
    )
    const info = footnoteOf(normalizeLabel(label))
    if (!info) continue
    sup.setAttribute('aria-label', info.tooltip)
    const number = sup.querySelector('[data-render]')
    if (number) number.textContent = String(info.number)
  }
  return template.innerHTML
}
