import { describe, expect, it } from 'vitest'
import {
  extractCustomId,
  parseHeadingsFromMarkdown,
  resolveFragment,
  slugify,
} from '../../src/shared/heading-slug'

// Task 243, L1: the shared heading-anchor resolver. `slugify` is pinned against the REAL
// `github-slugger@2` (npm) and GitLab's `Gitlab::HeadingSlug.from_text` (Ruby, gitlab-org/gitlab
// lib/gitlab/heading_slug.rb) outputs for the same inputs — run locally with both runtimes, not
// guessed — so these cases are the ground truth, not a self-consistency check.

describe('extractCustomId', () => {
  it('splits a trailing {#custom-id} marker off the display text', () => {
    expect(extractCustomId('Custom Section {#custom-id}')).toEqual({
      text: 'Custom Section',
      customId: 'custom-id',
    })
  })

  it('leaves plain heading text untouched', () => {
    expect(extractCustomId('Plain Heading')).toEqual({ text: 'Plain Heading' })
  })

  it('tolerates no space before the marker', () => {
    expect(extractCustomId('Heading{#id}')).toEqual({
      text: 'Heading',
      customId: 'id',
    })
  })

  it('only strips a TRAILING marker, not one mid-text', () => {
    // {#..} in the middle isn't the kramdown/Lute heading-id position — leave it as text.
    expect(extractCustomId('{#id} in the middle')).toEqual({
      text: '{#id} in the middle',
    })
  })

  it('allows unicode in the custom id', () => {
    expect(extractCustomId('Résumé {#résumé}')).toEqual({
      text: 'Résumé',
      customId: 'résumé',
    })
  })
})

describe('slugify — github mode (pinned to github-slugger@2)', () => {
  const cases: Array<[string, string]> = [
    ['The Heading', 'the-heading'],
    ['Custom Section', 'custom-section'],
    ['Hello, World!', 'hello-world'],
    ['  Leading/trailing spaces  ', '--leadingtrailing-spaces--'],
    ['Héllo Wörld — Café', 'héllo-wörld--café'],
    ['日本語の見出し', '日本語の見出し'],
    ['Hello 👋 World', 'hello--world'],
    ['3. Third heading', '3-third-heading'],
    ['123 Numbers First', '123-numbers-first'],
    ['C++ & C#', 'c--c'],
    ['Foo_Bar-Baz', 'foo_bar-baz'],
    ['Multiple   Spaces', 'multiple---spaces'],
    ['Tab\tSeparated', 'tabseparated'],
    ['Emoji 🎉🎊 Party', 'emoji--party'],
    ['Ünïcödé Ñ', 'ünïcödé-ñ'],
    ['Русский язык', 'русский-язык'],
    ['中文 标题', '中文-标题'],
    ['a/b/c', 'abc'],
    ['<script>alert(1)</script>', 'scriptalert1script'],
    ['Question?', 'question'],
    ["Apostrophe's Test", 'apostrophes-test'],
    ['100% Done', '100-done'],
    ['a---b', 'a---b'],
    ['a  -  b', 'a-----b'],
  ]
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(slugify(input, 'github')).toBe(expected)
    })
  }
})

describe('slugify — gitlab mode (pinned to Gitlab::HeadingSlug.from_text, Ruby)', () => {
  // GitLab's regex differs from GitHub's only in keeping the whole Unicode "Connector
  // Punctuation" category (\p{Pc}) instead of a literal `_` — no realistic heading tells the
  // two flavors apart, which the shared battery below (run against BOTH modes) demonstrates;
  // this block pins gitlab mode specifically against the actual Ruby output.
  const cases: Array<[string, string]> = [
    ['The Heading', 'the-heading'],
    ['Hello, World!', 'hello-world'],
    ['Héllo Wörld — Café', 'héllo-wörld--café'],
    ['Hello 👋 World', 'hello--world'],
    ['Foo_Bar-Baz', 'foo_bar-baz'],
    ['123 Numbers First', '123-numbers-first'],
    ['Русский язык', 'русский-язык'],
  ]
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(slugify(input, 'gitlab')).toBe(expected)
    })
  }

  it('defaults to github mode when unspecified', () => {
    expect(slugify('Hello World')).toBe(slugify('Hello World', 'github'))
  })
})

describe('parseHeadingsFromMarkdown', () => {
  it('records the zero-based source line of each heading, past fences and CRLF', () => {
    expect(
      parseHeadingsFromMarkdown('# A\n~~~\n# no\n~~~\n\n## B\n').map(
        (h) => h.line,
      ),
    ).toEqual([0, 5])
    expect(
      parseHeadingsFromMarkdown('# One\r\n\r\n## Two\r\n').map((h) => h.line),
    ).toEqual([0, 2])
  })

  it('parses ATX headings in document order with a running index', () => {
    const h = parseHeadingsFromMarkdown('# One\n\n## Two\n\n# Three\n')
    expect(h).toEqual([
      { level: 1, text: 'One', customId: undefined, index: 0, line: 0 },
      { level: 2, text: 'Two', customId: undefined, index: 1, line: 2 },
      { level: 1, text: 'Three', customId: undefined, index: 2, line: 4 },
    ])
  })

  it('splits {#custom-id} off each heading independently', () => {
    const h = parseHeadingsFromMarkdown(
      '# Plain\n\n## Custom Section {#custom-id}\n',
    )
    expect(h[0]).toEqual({
      level: 1,
      text: 'Plain',
      customId: undefined,
      index: 0,
      line: 0,
    })
    expect(h[1]).toEqual({
      level: 2,
      text: 'Custom Section',
      customId: 'custom-id',
      index: 1,
      line: 2,
    })
  })

  it('skips ATX-looking lines inside fenced code blocks', () => {
    const h = parseHeadingsFromMarkdown(
      '# Real\n\n```\n# fake\n## also fake\n```\n\n## After\n',
    )
    expect(h.map((x) => x.text)).toEqual(['Real', 'After'])
    expect(h.map((x) => x.index)).toEqual([0, 1])
  })

  it('handles ~~~ fences too', () => {
    const h = parseHeadingsFromMarkdown('# A\n~~~\n# nope\n~~~\n# B\n')
    expect(h.map((x) => x.text)).toEqual(['A', 'B'])
  })

  it('strips a closing ATX sequence', () => {
    const h = parseHeadingsFromMarkdown('## Title ##\n')
    expect(h[0].text).toBe('Title')
  })

  it('normalizes CRLF line endings', () => {
    const h = parseHeadingsFromMarkdown('# One\r\n\r\n## Two\r\n')
    expect(h.map((x) => x.text)).toEqual(['One', 'Two'])
  })

  it('returns nothing for a heading-free document', () => {
    expect(parseHeadingsFromMarkdown('plain text\nmore text\n')).toEqual([])
  })
})

describe('resolveFragment', () => {
  it('resolves a plain-text slug to its heading index', () => {
    const headings = parseHeadingsFromMarkdown('# The Heading\n\n## Other\n')
    expect(resolveFragment(headings, 'the-heading')).toBe(0)
    expect(resolveFragment(headings, 'other')).toBe(1)
  })

  it('custom id beats slug when both would otherwise match', () => {
    // A heading whose custom id happens to equal what heading 0's slug would have been.
    const headings = parseHeadingsFromMarkdown(
      '# Real Slug Target\n\n## Aside {#real-slug-target}\n',
    )
    // "real-slug-target" is heading 0's slug AND heading 1's custom id — custom id wins.
    expect(resolveFragment(headings, 'real-slug-target')).toBe(1)
  })

  it('falls back to the slug map when no custom id matches', () => {
    const headings = parseHeadingsFromMarkdown(
      '# Custom Section {#custom-id}\n\n## Plain Heading\n',
    )
    expect(resolveFragment(headings, 'custom-id')).toBe(0)
    expect(resolveFragment(headings, 'plain-heading')).toBe(1)
  })

  it('resolves duplicate-text headings via github-style -1/-2 dedup suffixes', () => {
    const headings = parseHeadingsFromMarkdown('# Foo\n\n## Foo\n\n### Foo\n')
    expect(resolveFragment(headings, 'foo')).toBe(0)
    expect(resolveFragment(headings, 'foo-1')).toBe(1)
    expect(resolveFragment(headings, 'foo-2')).toBe(2)
  })

  it('a later heading colliding with an already-suffixed slug gets suffixed again', () => {
    // "Foo", "Foo" -> foo, foo-1. A THIRD heading literally titled "Foo-1" slugifies to
    // "foo-1" too, which already exists, so it must become "foo-1-1" — the naive
    // flat-counter dedup (keyed only on the un-suffixed base) would collide instead.
    const headings = parseHeadingsFromMarkdown('# Foo\n\n## Foo\n\n### Foo-1\n')
    expect(resolveFragment(headings, 'foo')).toBe(0)
    expect(resolveFragment(headings, 'foo-1')).toBe(1)
    expect(resolveFragment(headings, 'foo-1-1')).toBe(2)
  })

  it('returns undefined for an unmatched fragment', () => {
    const headings = parseHeadingsFromMarkdown('# The Heading\n')
    expect(resolveFragment(headings, 'does-not-exist')).toBeUndefined()
  })

  it('returns undefined for an empty fragment', () => {
    const headings = parseHeadingsFromMarkdown('# The Heading\n')
    expect(resolveFragment(headings, '')).toBeUndefined()
  })

  it('returns undefined against a heading-free document', () => {
    expect(resolveFragment([], 'anything')).toBeUndefined()
  })

  it('slug resolution respects the gitlab mode when passed', () => {
    const headings = parseHeadingsFromMarkdown('# Foo_Bar\n')
    expect(resolveFragment(headings, 'foo_bar', 'gitlab')).toBe(0)
    expect(resolveFragment(headings, 'foo_bar', 'github')).toBe(0)
  })

  it('unicode headings resolve by their unicode slug (no ASCII transliteration)', () => {
    const headings = parseHeadingsFromMarkdown('# 日本語の見出し\n')
    expect(resolveFragment(headings, '日本語の見出し')).toBe(0)
  })

  it('emoji-containing headings resolve after the emoji is stripped', () => {
    const headings = parseHeadingsFromMarkdown('# Hello 👋 World\n')
    expect(resolveFragment(headings, 'hello--world')).toBe(0)
  })

  it('a leading-digit heading resolves without a letter prefix', () => {
    const headings = parseHeadingsFromMarkdown('# 123 Numbers First\n')
    expect(resolveFragment(headings, '123-numbers-first')).toBe(0)
  })
})
