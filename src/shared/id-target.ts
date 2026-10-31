import {
  parseHeadingsFromMarkdown,
  resolveFragment,
  type SlugifyMode,
} from './heading-slug'
import { createFenceTracker } from './md-scan'

export type IdTargetAttribute = 'id' | 'name'

export interface IdTarget {
  /** Source spelling of the attribute value; target matching is case-sensitive. */
  value: string
  /** Zero-based source line containing the opening tag. */
  line: number
  attribute: IdTargetAttribute
}

function isEscaped(source: string, offset: number): boolean {
  let slashes = 0
  for (let index = offset - 1; index >= 0 && source[index] === '\\'; index--)
    slashes++
  return slashes % 2 === 1
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: delimiter-width matching keeps the scanner source-offset safe without a lossy regex.
function inlineCodeSpans(line: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  for (let start = 0; start < line.length; start++) {
    if (line[start] !== '`' || isEscaped(line, start)) continue
    let width = 1
    while (line[start + width] === '`') width++
    for (let end = start + width; end < line.length; end++) {
      if (line[end] !== '`' || isEscaped(line, end)) continue
      let closingWidth = 1
      while (line[end + closingWidth] === '`') closingWidth++
      if (closingWidth === width) {
        spans.push({ start, end: end + width })
        start = end + width - 1
        break
      }
      end += closingWidth - 1
    }
  }
  return spans
}

function inSpan(
  spans: readonly { start: number; end: number }[],
  offset: number,
) {
  return spans.some((span) => offset >= span.start && offset < span.end)
}

const TAG_NAME = /^<([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/u
const ATTRIBUTE_NAME = /^[^\s"'>/=]+/u
const QUOTED_VALUE = /^\s*=\s*(["'])(.*?)\1/su
const OTHER_VALUE = /^\s*=\s*[^\s>]*/u

/** Quoted, non-empty attribute values of one tag body; the first occurrence of a name wins. */
function quotedAttributes(body: string): Map<string, string> {
  const values = new Map<string, string>()
  const seen = new Set<string>()
  let rest = body
  while (rest.length > 0) {
    rest = rest.replace(/^[\s/]+/u, '')
    const name = ATTRIBUTE_NAME.exec(rest)
    if (!name) break
    rest = rest.slice(name[0].length)
    const quoted = QUOTED_VALUE.exec(rest)
    rest = rest.slice((quoted ?? OTHER_VALUE.exec(rest))?.[0].length ?? 0)
    const key = name[0].toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (quoted?.[2]) values.set(key, quoted[2])
  }
  return values
}

/**
 * Targets declared by one opening tag: `id` on any element, `name` only on `<a>`. Attribute
 * names are tokenized, so `data-id` is not `id`; only quoted, non-empty values count (the
 * portable GitHub syntax), and the first occurrence of an attribute wins, as in HTML.
 */
export function idTargetsInTag(
  tag: string,
): Array<{ value: string; attribute: IdTargetAttribute }> {
  const open = TAG_NAME.exec(tag)
  if (!open) return []
  const values = quotedAttributes(tag.slice(open[0].length, -1))
  const targets: Array<{ value: string; attribute: IdTargetAttribute }> = []
  const id = values.get('id')
  const name = open[1].toLowerCase() === 'a' ? values.get('name') : undefined
  if (id) targets.push({ value: id, attribute: 'id' })
  if (name) targets.push({ value: name, attribute: 'name' })
  return targets
}

/** Scan HTML `id` (any element) and `<a name>` targets without treating code as HTML. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear scanner preserves quoted-tag and code/fence guards before declaring a target.
export function parseIdTargetsFromMarkdown(markdown: string): IdTarget[] {
  const targets: IdTarget[] = []
  const fences = createFenceTracker()
  for (const [line, raw] of markdown.split('\n').entries()) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (fences.consume(text) || /^(?: {4}|\t)/u.test(text)) continue
    const code = inlineCodeSpans(text)
    for (let start = 0; start < text.length; start++) {
      if (text[start] !== '<' || isEscaped(text, start) || inSpan(code, start))
        continue
      let quote = ''
      let end = -1
      for (let index = start + 1; index < text.length; index++) {
        const char = text[index]
        if (quote) {
          if (char === quote && !isEscaped(text, index)) quote = ''
          continue
        }
        if (char === '"' || char === "'") quote = char
        else if (char === '>') {
          end = index + 1
          break
        }
      }
      if (end < 0) continue
      for (const target of idTargetsInTag(text.slice(start, end)))
        targets.push({ ...target, line })
      start = end - 1
    }
  }
  return targets
}

/** decodeURIComponent with the raw text as the fallback for a malformed escape. */
export function decodeFragment(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    // Keep a literal percent sign usable in a hand-authored target.
    return raw
  }
}

/** First `id` target with the (already decoded) value, else the first `name` target. */
export function findIdTarget(
  targets: readonly IdTarget[],
  value: string,
): IdTarget | undefined {
  return (
    targets.find((t) => t.attribute === 'id' && t.value === value) ??
    targets.find((t) => t.attribute === 'name' && t.value === value)
  )
}

export type FragmentTarget =
  | { kind: 'heading'; index: number }
  | { kind: 'target'; target: IdTarget }

/**
 * One resolver for host and webview. A heading and an `id` target share one name space: the
 * first in document order wins (a heading wins on the same line); a legacy `name` target is used
 * only when neither exists. `rawFragment` is the undecoded text after `#`.
 */
export function resolveFragmentTarget(
  markdown: string,
  rawFragment: string,
  mode: SlugifyMode,
): FragmentTarget | undefined {
  const value = decodeFragment(rawFragment)
  if (!value) return undefined
  const headings = parseHeadingsFromMarkdown(markdown)
  const headingIndex = resolveFragment(headings, value, mode)
  const heading =
    headingIndex === undefined
      ? undefined
      : headings.find((h) => h.index === headingIndex)
  const targets = parseIdTargetsFromMarkdown(markdown)
  const idTarget = targets.find(
    (t) => t.attribute === 'id' && t.value === value,
  )
  if (heading && (!idTarget || heading.line <= idTarget.line))
    return { kind: 'heading', index: heading.index }
  if (idTarget) return { kind: 'target', target: idTarget }
  const named = findIdTarget(targets, value)
  return named ? { kind: 'target', target: named } : undefined
}
