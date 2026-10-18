// Task 655 — pure recognition of a "bare URL" in prose text: the GFM spec's extended autolinks
// (`www.`, `http://`, `https://` and email addresses). This is the PRODUCT definition, not Lute's
// own autolinking: Lute never autolinks in any Vditor mode (its inline guard skips GFMAutoLink
// whenever a Vditor mode flag is set), and with the flags cleared it is wrong in several cases
// (broken `h`+`ttp://a` links, nested anchors in footnotes, `mailto:` links on `x@y`), so the
// decorator in bare-url-decorate.ts uses this matcher in every pane instead.
//
// No DOM, no state. `findBareUrls` is a fast no-op for text with none of `://`, `www.` or `@`.

export interface BareUrlMatch {
  index: number
  source: string
  href: string
  kind: 'url' | 'www' | 'email'
}

// A match may start at the beginning of the text node, after whitespace, or after one of these.
const START_DELIMITERS = '*_~('
// Trailing characters that are never part of the link.
const TRAILING_PUNCTUATION = '?!.,:*_~'

const SCHEME_OR_WWW = /https?:\/\/|www\./g
const HOST_END = /[/?#:]/
const DOMAIN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/
const EMAIL_LOCAL = /[A-Za-z0-9._+-]/
const EMAIL_DOMAIN = /[A-Za-z0-9._-]/
const WHITESPACE = /\s/

function isStartBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  const prev = text[index - 1]
  return WHITESPACE.test(prev) || START_DELIMITERS.includes(prev)
}

function validDomain(host: string): boolean {
  if (!DOMAIN.test(host)) return false
  const segments = host.split('.')
  return !segments.slice(-2).some((segment) => segment.includes('_'))
}

function countChar(text: string, ch: string): number {
  let n = 0
  for (const c of text) if (c === ch) n++
  return n
}

/** Drop trailing punctuation, an unmatched `)` and a trailing `&name;` entity, until stable. */
function trimTrailing(run: string): string {
  let end = run.length
  while (end > 0) {
    const last = run[end - 1]
    if (TRAILING_PUNCTUATION.includes(last)) {
      end--
      continue
    }
    if (last === ')') {
      const body = run.slice(0, end)
      if (countChar(body, ')') > countChar(body, '(')) {
        end--
        continue
      }
      break
    }
    if (last === ';') {
      const entity = /&[A-Za-z0-9]+;$/.exec(run.slice(0, end))
      if (entity) {
        end -= entity[0].length
        continue
      }
    }
    break
  }
  return run.slice(0, end)
}

function urlRunEnd(text: string, from: number): number {
  let end = from
  while (end < text.length && !WHITESPACE.test(text[end]) && text[end] !== '<')
    end++
  return end
}

/** The URL match whose scheme or `www.` prefix starts at `index`, or null when it is not valid. */
function urlAt(
  text: string,
  index: number,
  prefix: string,
): BareUrlMatch | null {
  if (!isStartBoundary(text, index)) return null
  const isWww = prefix === 'www.'
  const source = trimTrailing(text.slice(index, urlRunEnd(text, index)))
  const rest = source.slice(isWww ? 0 : prefix.length)
  const cut = rest.search(HOST_END)
  if (!validDomain(cut < 0 ? rest : rest.slice(0, cut))) return null
  return {
    index,
    source,
    href: isWww ? `http://${source}` : source,
    kind: isWww ? 'www' : 'url',
  }
}

function findUrls(text: string): BareUrlMatch[] {
  const found: BareUrlMatch[] = []
  SCHEME_OR_WWW.lastIndex = 0
  let hit = SCHEME_OR_WWW.exec(text)
  while (hit) {
    const match = urlAt(text, hit.index, hit[0])
    if (match) found.push(match)
    SCHEME_OR_WWW.lastIndex = match
      ? match.index + match.source.length
      : hit.index + 1
    hit = SCHEME_OR_WWW.exec(text)
  }
  return found
}

function findEmails(text: string, taken: BareUrlMatch[]): BareUrlMatch[] {
  const found: BareUrlMatch[] = []
  let at = text.indexOf('@')
  while (at !== -1) {
    let start = at
    while (start > 0 && EMAIL_LOCAL.test(text[start - 1])) start--
    let end = at + 1
    while (end < text.length && EMAIL_DOMAIN.test(text[end])) end++
    while (end > at + 1 && text[end - 1] === '.') end--
    const domain = text.slice(at + 1, end)
    const last = domain.at(-1)
    const overlaps = taken.some(
      (m) => start < m.index + m.source.length && end > m.index,
    )
    if (
      start < at &&
      last !== undefined &&
      last !== '-' &&
      last !== '_' &&
      DOMAIN.test(domain) &&
      !overlaps
    )
      found.push({
        index: start,
        source: text.slice(start, end),
        href: `mailto:${text.slice(start, end)}`,
        kind: 'email',
      })
    at = text.indexOf('@', Math.max(end, at + 1))
  }
  return found
}

/** Bare URLs in `text`, left to right and non-overlapping. */
export function findBareUrls(text: string): BareUrlMatch[] {
  if (!text.includes('://') && !text.includes('www.') && !text.includes('@'))
    return []
  const urls = findUrls(text)
  const emails = text.includes('@') ? findEmails(text, urls) : []
  return [...urls, ...emails].sort((a, b) => a.index - b.index)
}
