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

// A match may start at the beginning of the text node, after whitespace, after one of these, or
// after full-width punctuation (CJK_STOP below).
const START_DELIMITERS = '*_~('
// Trailing characters that are never part of the link.
const TRAILING_PUNCTUATION = '?!.,:*_~'

const SCHEME_OR_WWW = /https?:\/\/|www\./g
// The host is the leading run of domain characters (cmark-gfm style): whatever follows it, such as a
// path or full-width text, never makes the candidate invalid.
const HOST_RUN = /^[A-Za-z0-9_.-]*/
// Full-width punctuation that ends a link: a deliberate extension of GFM's trailing-punctuation rule
// for CJK text (full-width and half-width CJK forms only, never Western quotes or an ellipsis), where no space separates a URL from the sentence (`https://x.com。下一句`).
const CJK_STOP =
  /[\u3001\u3002\u3008-\u3011\uff01\uff08\uff09\uff0c\uff0e\uff1a\uff1b\uff1f\uff3b\uff3d\uff5b\uff5d\uff5e\uff61\uff64]/u
const DOMAIN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/
const EMAIL_LOCAL = /[A-Za-z0-9._+-]/
const EMAIL_DOMAIN = /[A-Za-z0-9._-]/
const WHITESPACE = /\s/

function isStartBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  const prev = text[index - 1]
  return (
    WHITESPACE.test(prev) ||
    START_DELIMITERS.includes(prev) ||
    CJK_STOP.test(prev)
  )
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
  while (
    end < text.length &&
    !WHITESPACE.test(text[end]) &&
    text[end] !== '<' &&
    !CJK_STOP.test(text[end])
  )
    end++
  return end
}

interface UrlCandidate {
  /** The accepted match, or null when the candidate was rejected. */
  match: BareUrlMatch | null
  /** End of the candidate's raw run (rejected candidates block the email scan over it). */
  end: number
}

/** The candidate whose scheme or `www.` prefix starts at `index`, or null at no start boundary. */
function urlAt(
  text: string,
  index: number,
  prefix: string,
): UrlCandidate | null {
  if (!isStartBoundary(text, index)) return null
  const isWww = prefix === 'www.'
  const end = urlRunEnd(text, index)
  const source = trimTrailing(text.slice(index, end))
  const rest = source.slice(isWww ? 0 : prefix.length)
  if (!validDomain(HOST_RUN.exec(rest)?.[0] ?? '')) return { match: null, end }
  return {
    match: {
      index,
      source,
      href: isWww ? `http://${source}` : source,
      kind: isWww ? 'www' : 'url',
    },
    end,
  }
}

interface UrlScan {
  urls: BareUrlMatch[]
  /** Raw runs of rejected candidates (`https://user:pass@host.com`), closed to the email scan. */
  blocked: Array<[number, number]>
}

function findUrls(text: string): UrlScan {
  const urls: BareUrlMatch[] = []
  const blocked: Array<[number, number]> = []
  SCHEME_OR_WWW.lastIndex = 0
  let hit = SCHEME_OR_WWW.exec(text)
  while (hit) {
    const candidate = urlAt(text, hit.index, hit[0])
    if (candidate?.match) urls.push(candidate.match)
    else if (candidate) blocked.push([hit.index, candidate.end])
    SCHEME_OR_WWW.lastIndex = candidate?.match
      ? candidate.match.index + candidate.match.source.length
      : hit.index + 1
    hit = SCHEME_OR_WWW.exec(text)
  }
  return { urls, blocked }
}

function findEmails(text: string, scan: UrlScan): BareUrlMatch[] {
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
    const overlaps =
      scan.urls.some(
        (m) => start < m.index + m.source.length && end > m.index,
      ) || scan.blocked.some(([from, to]) => start < to && end > from)
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
  const scan = findUrls(text)
  const emails = text.includes('@') ? findEmails(text, scan) : []
  return [...scan.urls, ...emails].sort((a, b) => a.index - b.index)
}
