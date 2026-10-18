import { describe, expect, it } from 'vitest'
import { findBareUrls } from './bare-url-match'

// Task 655 — the matcher is the product definition of "a bare URL" (GFM extended autolinks), not
// Lute's own autolinking, which is wrong in the cases listed under "Lute divergences" below.
// Each row: input text -> [index, source, href, kind] tuples.
type Row = [string, Array<[number, string, string, string]>]

function run(text: string): Array<[number, string, string, string]> {
  return findBareUrls(text).map((m) => [m.index, m.source, m.href, m.kind])
}

function one(
  text: string,
  source: string,
  href = source,
  kind = 'url',
): [string, Array<[number, string, string, string]>] {
  return [text, [[text.indexOf(source), source, href, kind]]]
}

describe('findBareUrls: GFM extended autolink examples', () => {
  const rows: Row[] = [
    one('Visit https://example.com today.', 'https://example.com'),
    one('https://example.com', 'https://example.com'),
    one('http://a.b', 'http://a.b'),
    one(
      'www.commonmark.org',
      'www.commonmark.org',
      'http://www.commonmark.org',
      'www',
    ),
    one(
      'Visit www.commonmark.org/help for more help.',
      'www.commonmark.org/help',
      'http://www.commonmark.org/help',
      'www',
    ),
    one(
      'Visit www.commonmark.org.',
      'www.commonmark.org',
      'http://www.commonmark.org',
      'www',
    ),
    one(
      'Visit www.commonmark.org/a.b.',
      'www.commonmark.org/a.b',
      'http://www.commonmark.org/a.b',
      'www',
    ),
    one(
      'www.google.com/search?q=Markup+(business)',
      'www.google.com/search?q=Markup+(business)',
      'http://www.google.com/search?q=Markup+(business)',
      'www',
    ),
    one(
      'www.google.com/search?q=(business))+ok',
      'www.google.com/search?q=(business))+ok',
      'http://www.google.com/search?q=(business))+ok',
      'www',
    ),
    one(
      'www.google.com/search?q=(business))',
      'www.google.com/search?q=(business)',
      'http://www.google.com/search?q=(business)',
      'www',
    ),
    one(
      '(www.google.com/search?q=commonmark)',
      'www.google.com/search?q=commonmark',
      'http://www.google.com/search?q=commonmark',
      'www',
    ),
    one(
      'www.google.com/search?q=commonmark&hl=en',
      'www.google.com/search?q=commonmark&hl=en',
      'http://www.google.com/search?q=commonmark&hl=en',
      'www',
    ),
    one(
      'www.google.com/search?q=commonmark&hl;',
      'www.google.com/search?q=commonmark',
      'http://www.google.com/search?q=commonmark',
      'www',
    ),
    one(
      'www.commonmark.org/he<lp',
      'www.commonmark.org/he',
      'http://www.commonmark.org/he',
      'www',
    ),
    one('http://commonmark.org', 'http://commonmark.org'),
    one(
      '(Visit https://encrypted.google.com/search?q=Markup+(business))',
      'https://encrypted.google.com/search?q=Markup+(business)',
    ),
    one('foo@bar.baz', 'foo@bar.baz', 'mailto:foo@bar.baz', 'email'),
    one(
      "hello@mail+xyz.example isn't valid, but hello+xyz@mail.example is.",
      'hello+xyz@mail.example',
      'mailto:hello+xyz@mail.example',
      'email',
    ),
    one('a.b-c_d@a.b', 'a.b-c_d@a.b', 'mailto:a.b-c_d@a.b', 'email'),
    one('a.b-c_d@a.b.', 'a.b-c_d@a.b', 'mailto:a.b-c_d@a.b', 'email'),
    ['a.b-c_d@a.b-', []],
    ['a.b-c_d@a.b_', []],
  ]
  it.each(rows)('%j', (text, expected) => {
    expect(run(text)).toEqual(expected)
  })
})

describe('findBareUrls: trailing punctuation, parentheses, entities', () => {
  const rows: Row[] = [
    one('See https://example.com, then', 'https://example.com'),
    one('(https://example.com)', 'https://example.com'),
    one('https://example.com?', 'https://example.com'),
    one('https://example.com!', 'https://example.com'),
    one('https://example.com:', 'https://example.com'),
    one('~https://example.com~', 'https://example.com'),
    one('*https://example.com*', 'https://example.com'),
    one('_https://example.com_', 'https://example.com'),
    one(
      'https://en.wikipedia.org/wiki/Foo_(bar).',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ),
    one('https://example.com/?a=1&amp;', 'https://example.com/?a=1'),
    one('https://example.com?&amp;', 'https://example.com'),
    one('https://example.com/a&amp;b', 'https://example.com/a&amp;b'),
    one('https://example.com/a<b', 'https://example.com/a'),
    one(
      'https://example.com/a?b=1&c=2#frag',
      'https://example.com/a?b=1&c=2#frag',
    ),
    one('https://example.com:8080/x', 'https://example.com:8080/x'),
  ]
  it.each(rows)('%j', (text, expected) => {
    expect(run(text)).toEqual(expected)
  })
})

describe('findBareUrls: start boundary', () => {
  it('links at the start of the text and after whitespace', () => {
    expect(run('https://a.com')).toEqual([
      [0, 'https://a.com', 'https://a.com', 'url'],
    ])
    expect(run('x\thttps://a.com')).toEqual([
      [2, 'https://a.com', 'https://a.com', 'url'],
    ])
    expect(run('x\nhttps://a.com')).toEqual([
      [2, 'https://a.com', 'https://a.com', 'url'],
    ])
  })
  it('does not link when a letter or slash precedes the scheme', () => {
    expect(run('xhttps://a.com')).toEqual([])
    expect(run('/https://a.com')).toEqual([])
    expect(run('xwww.a.com')).toEqual([])
  })
  it('does not link directly after a CJK character, and links after a space', () => {
    expect(run('详见https://example.com')).toEqual([])
    expect(run('详见 https://example.com')).toEqual([
      [3, 'https://example.com', 'https://example.com', 'url'],
    ])
  })
})

describe('findBareUrls: several matches', () => {
  it('returns left-to-right, non-overlapping matches with correct indexes', () => {
    expect(run('https://a.com and www.b.org, x@y.io')).toEqual([
      [0, 'https://a.com', 'https://a.com', 'url'],
      [18, 'www.b.org', 'http://www.b.org', 'www'],
      [29, 'x@y.io', 'mailto:x@y.io', 'email'],
    ])
  })
  it('does not report an email or a nested www inside a URL', () => {
    expect(run('https://example.com/a@b.co')).toEqual([
      [0, 'https://example.com/a@b.co', 'https://example.com/a@b.co', 'url'],
    ])
    expect(run('https://www.example.com')).toEqual([
      [0, 'https://www.example.com', 'https://www.example.com', 'url'],
    ])
  })
})

describe('findBareUrls: Lute divergences (product contract)', () => {
  it('does not link a dotless host (http://a, localhost)', () => {
    expect(run('http://a')).toEqual([])
    expect(run('http://localhost:3000')).toEqual([])
    expect(run('http://localhost/x.y')).toEqual([])
    expect(run('www')).toEqual([])
    expect(run('www.')).toEqual([])
  })
  it('does not link x@y or a dotless email domain', () => {
    expect(run('x@y')).toEqual([])
    expect(run('Atfw.@lytkk')).toEqual([])
  })
  it('does not link schemes other than http and https', () => {
    expect(run('file:///tmp/x')).toEqual([])
    expect(run('vscode://file/x')).toEqual([])
    expect(run('ftp://example.com')).toEqual([])
    expect(run('javascript://example.com/%0Aalert(1)')).toEqual([])
  })
  it('keeps percent escapes verbatim in the source text and the href', () => {
    expect(run('https://j.com/~user/%20x?y=z+w')).toEqual([
      [
        0,
        'https://j.com/~user/%20x?y=z+w',
        'https://j.com/~user/%20x?y=z+w',
        'url',
      ],
    ])
  })
  it('rejects an underscore in the last two host segments', () => {
    expect(run('https://foo.bar_baz.com/x')).toEqual([])
    expect(run('https://a_b.example.com/x')).toEqual([
      [0, 'https://a_b.example.com/x', 'https://a_b.example.com/x', 'url'],
    ])
  })
})

describe('findBareUrls: full-width CJK punctuation (deliberate extension of GFM trailing punctuation)', () => {
  const rows: Row[] = [
    one('https://x.com\u3002\u4e0b\u4e00\u53e5', 'https://x.com'),
    one('\u89c1 https://x.com/a\u3002', 'https://x.com/a'),
    one(
      '\u8bbf\u95ee www.example.com\u3002',
      'www.example.com',
      'http://www.example.com',
      'www',
    ),
    one('\uff08https://x.com/a\uff09\u3002', 'https://x.com/a'),
    one('\u300chttps://x.com/a\u300d', 'https://x.com/a'),
    one('https://x.com/a\uff0c\u7136\u540e', 'https://x.com/a'),
    one('https://x.com\u4e0b\u4e00\u53e5', 'https://x.com\u4e0b\u4e00\u53e5'),
  ]
  it.each(rows)('%j', (text, expected) => {
    expect(run(text)).toEqual(expected)
  })
})

describe('findBareUrls: only CJK punctuation ends a link', () => {
  it('keeps Western curly quotes and an ellipsis inside the link', () => {
    expect(run('https://example.com/it\u2019s')).toEqual([
      [
        0,
        'https://example.com/it\u2019s',
        'https://example.com/it\u2019s',
        'url',
      ],
    ])
    expect(run('https://example.com/a\u2026b')).toEqual([
      [
        0,
        'https://example.com/a\u2026b',
        'https://example.com/a\u2026b',
        'url',
      ],
    ])
  })
  it.each([
    ['\uff61', 'half-width ideographic full stop'],
    ['\uff64', 'half-width ideographic comma'],
    ['\uff5e', 'full-width tilde'],
  ])('ends the link at %j (%s)', (stop) => {
    expect(run(`https://x.com/a${stop}tail`)).toEqual([
      [0, 'https://x.com/a', 'https://x.com/a', 'url'],
    ])
  })
})

describe('findBareUrls: rejected URL candidates do not leak an email', () => {
  it('does not report mailto from credentials in a rejected URL', () => {
    expect(run('https://user:pass@host.com/x')).toEqual([])
  })
  it('still reports an email outside the rejected candidate', () => {
    expect(run('http://localhost a@b.co')).toEqual([
      [17, 'a@b.co', 'mailto:a@b.co', 'email'],
    ])
  })
  it('links the written mailto: address only', () => {
    expect(run('mailto:a@b.co')).toEqual([
      [7, 'a@b.co', 'mailto:a@b.co', 'email'],
    ])
  })
})

describe('findBareUrls: fast path', () => {
  it('returns an empty list for text with no ://, www. or @', () => {
    expect(run('')).toEqual([])
    expect(
      run('plain text, nothing to link. Example.com is not linked either.'),
    ).toEqual([])
  })
})
