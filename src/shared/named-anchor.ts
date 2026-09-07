import { createFenceTracker } from './md-scan'

export interface NamedAnchor {
  /** Source spelling of the `name` attribute; target matching is case-sensitive. */
  name: string
  /** Zero-based source line containing the opening `<a>` tag. */
  line: number
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

function namedAnchorInTag(tag: string): string | undefined {
  const open = /^<a(?=\s|\/?>)/iu.exec(tag)
  if (!open || /^<a\s*\//iu.test(tag)) return undefined
  const attrs = tag.slice(open[0].length, -1)
  // Only quoted values are accepted. It is the portable GitHub syntax and refusing
  // malformed/unquoted tags means a literal source fragment never becomes a target.
  const name = /(?:^|\s)name\s*=\s*(["'])(.*?)\1/iu.exec(attrs)
  return name?.[2] || undefined
}

/** Scan the supported GitHub `<a name="…"></a>` source syntax without treating code as HTML. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear scanner preserves quoted-tag and code/fence guards before declaring a target.
export function parseNamedAnchorsFromMarkdown(markdown: string): NamedAnchor[] {
  const anchors: NamedAnchor[] = []
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
      const name = namedAnchorInTag(text.slice(start, end))
      if (name) anchors.push({ name, line })
      start = end - 1
    }
  }
  return anchors
}

/** Resolve the first same-name target after decoding a URL fragment. */
export function findNamedAnchor(
  anchors: readonly NamedAnchor[],
  rawFragment: string,
): NamedAnchor | undefined {
  let fragment = rawFragment
  try {
    fragment = decodeURIComponent(rawFragment)
  } catch {
    // Keep a literal percent sign usable in a hand-authored target.
  }
  return anchors.find((anchor) => anchor.name === fragment)
}
