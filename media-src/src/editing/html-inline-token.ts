export interface HtmlInlineToken {
  name: string
  closing: boolean
  void: boolean
}
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])
/** Parses one complete Vditor html-inline token without normalizing its source spelling. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validates quoted attribute grammar without normalizing source bytes
export function parseHtmlInlineToken(source: string): HtmlInlineToken | null {
  const token = source.startsWith('\u200b') ? source.slice(1) : source
  if (!token.startsWith('<') || !token.endsWith('>') || /<\s/u.test(token))
    return null
  let i = 1
  let closing = false
  if (token[i] === '/') {
    closing = true
    i++
    if (/\s/u.test(token[i] ?? '')) return null
  }
  const start = i
  while (/[A-Za-z0-9-]/u.test(token[i] ?? '')) i++
  if (i === start) return null
  const name = token.slice(start, i).toLowerCase()
  if (closing)
    return token.slice(i, -1).trim() === ''
      ? { name, closing, void: false }
      : null
  const attrs = token.slice(i, -1)
  if (attrs && !/^\s+/u.test(attrs)) return null
  const attr =
    /\s+([A-Za-z_:][A-Za-z0-9:._-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gy
  let cursor = 0
  while (cursor < attrs.length) {
    if (attrs.slice(cursor).trim() === '') break
    attr.lastIndex = cursor
    const match = attr.exec(attrs)
    if (!match) return null
    cursor = attr.lastIndex
  }
  if (/\/\s*>$/u.test(token)) return null
  return { name, closing: false, void: VOID.has(name) }
}
