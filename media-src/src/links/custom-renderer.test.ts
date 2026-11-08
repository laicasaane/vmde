import { describe, expect, it } from 'vitest'
import { WikiLinkPattern } from '../../../src/shared/wiki-core'
import {
  wikiAliasHintItems,
  wikiHintItems,
  wikiTextToHtml,
} from './custom-renderer'

describe('wikiHintItems', () => {
  it('filters case-insensitively, escapes values, and restores a consumed separator', () => {
    expect(wikiHintItems('ho', ['Home', 'Alpha'], ' ')).toEqual([
      {
        html: 'Home',
        value:
          ' <span class="wiki-link-chip" data-wiki-link="1" data-wiki-target="Home" data-wiki-source="[[Home]]">Home</span>',
      },
    ])
    expect(wikiHintItems('', ['A & B'])[0]?.value).toContain('A &amp; B')
  })
})

// Task 709 — alias hint rows show `alias → file` and insert the chip `[[file|alias]]` (Q2 option a).
describe('wikiAliasHintItems', () => {
  const aliases = [
    { alias: 'Some Alias', file: 'Target Page' },
    { alias: 'Other', file: 'Beta' },
  ]

  it('A7 renders alias → file with U+2192 and one space each side', () => {
    expect(wikiAliasHintItems('some', aliases)[0]?.html).toBe(
      'Some Alias \u2192 Target Page',
    )
  })

  it('A7 filters case-insensitively on the alias, not on the file', () => {
    expect(wikiAliasHintItems('SOME', aliases)).toHaveLength(1)
    expect(wikiAliasHintItems('some', aliases)).toHaveLength(1)
    expect(wikiAliasHintItems('beta', aliases)).toHaveLength(0)
    expect(wikiAliasHintItems('', aliases)).toHaveLength(2)
    expect(wikiAliasHintItems('zzz', aliases)).toEqual([])
  })

  it('A7 inserts the chip of [[file|alias]]: target is the file, source keeps the alias', () => {
    expect(wikiAliasHintItems('some', aliases)).toEqual([
      {
        html: 'Some Alias \u2192 Target Page',
        value:
          '<span class="wiki-link-chip" data-wiki-link="1" data-wiki-target="Target Page" data-wiki-source="[[Target Page|Some Alias]]">Some Alias</span>',
      },
    ])
  })

  it('A7 escapes <, &, and " in the row text and the chip attributes', () => {
    const [item] = wikiAliasHintItems('', [
      { alias: 'A<b> & "q"', file: 'F&G' },
    ])
    expect(item?.html).toBe('A&lt;b&gt; &amp; &quot;q&quot; \u2192 F&amp;G')
    expect(item?.value).toContain('data-wiki-target="F&amp;G"')
    expect(item?.value).toContain(
      'data-wiki-source="[[F&amp;G|A&lt;b&gt; &amp; &quot;q&quot;]]"',
    )
    expect(item?.value).toContain('>A&lt;b&gt; &amp; &quot;q&quot;</span>')
    expect(item?.value).not.toContain('<b>')
  })

  it('A7 restores a consumed separator through the prefix (ZWSP key)', () => {
    expect(wikiAliasHintItems('some', aliases, ' ')[0]?.value).toMatch(
      /^ <span class="wiki-link-chip"/,
    )
  })
})

// wikiTextToHtml is the pure core of the wiki-link renderer (the Lute renderText
// callback): [[wiki]] / [[wiki|label]] -> chips, everything else HTML-escaped.
describe('wikiTextToHtml', () => {
  it('escapes plain text and renders no chip', () => {
    expect(wikiTextToHtml('a < b & "c"', true)).toBe(
      'a &lt; b &amp; &quot;c&quot;',
    )
    expect(wikiTextToHtml('plain text', true)).not.toContain('wiki-link-chip')
  })

  it('passes text through (escaped) when wiki links are disabled', () => {
    expect(wikiTextToHtml('see [[Page]] here', false)).toBe('see [[Page]] here')
  })

  it('renders a single link as a chip with target/source/display', () => {
    const html = wikiTextToHtml('[[Page]]', true)
    expect(html).toContain('class="wiki-link-chip"')
    expect(html).toContain('data-wiki-target="Page"')
    expect(html).toContain('data-wiki-source="[[Page]]"')
    expect(html).toContain('data-wiki-link="1"')
    expect(html).toMatch(/>Page<\/span>/)
  })

  // Task 457 — chips ship WITHOUT tabindex: Tab can never reach an in-document chip regardless
  // (Vditor's `tab: '\t'` swallows every Tab in the editable surface), so a tabindex would only
  // ever create dead-focus mid-paragraph stops if Tab were ever freed. Activation is caret-targeted
  // (Ctrl/Cmd+Enter, link-click-fix.ts's activateLinkAtCaret) instead of focus-based.
  it('is not keyboard-focusable (no tabindex — activation is caret-targeted, not focus-based)', () => {
    const html = wikiTextToHtml('[[Page]]', true)
    expect(html).not.toContain('tabindex')
  })

  it('uses the label after "|" as display text, keeping the target', () => {
    const html = wikiTextToHtml('[[Page|Shown]]', true)
    expect(html).toContain('data-wiki-target="Page"')
    expect(html).toMatch(/>Shown<\/span>/)
  })

  it('keeps and escapes the surrounding text around a link', () => {
    const html = wikiTextToHtml('a <b> [[P]] & c', true)
    expect(html.startsWith('a &lt;b&gt; ')).toBe(true)
    expect(html.endsWith(' &amp; c')).toBe(true)
    expect(html).toContain('wiki-link-chip')
  })

  it('renders multiple links in one run', () => {
    const html = wikiTextToHtml('[[A]] and [[B]]', true)
    expect(html.match(/wiki-link-chip/g)).toHaveLength(2)
    expect(html).toContain('data-wiki-target="A"')
    expect(html).toContain('data-wiki-target="B"')
  })

  it('flags missing pages via knownPages (normalized) and titles them', () => {
    const known = new Set(['home', 'my-page'])
    const present = wikiTextToHtml('[[Home]]', true, known)
    expect(present).not.toContain('data-wiki-missing')
    expect(present).toContain('title="Open wiki page Home"')

    // normalization: "My Page" -> "my-page" is in the set
    expect(wikiTextToHtml('[[My Page]]', true, known)).not.toContain(
      'data-wiki-missing',
    )

    const missing = wikiTextToHtml('[[Ghost]]', true, known)
    expect(missing).toContain('data-wiki-missing="1"')
    expect(missing).toContain('title="Missing wiki page Ghost"')
  })

  it('never flags missing when no knownPages set is given', () => {
    expect(wikiTextToHtml('[[Anything]]', true)).not.toContain(
      'data-wiki-missing',
    )
  })

  it('escapes special characters inside the target and display', () => {
    const html = wikiTextToHtml('[[A & B]]', true)
    expect(html).toContain('data-wiki-target="A &amp; B"')
    expect(html).toMatch(/>A &amp; B<\/span>/)
  })

  // Task 470 — WikiLinkPattern is a module-level /g regex also read by wiki-serialize.ts,
  // lute-host.ts, and wiki-core.ts's own extractWikiTargets. wikiTextToHtml used to reuse that
  // SAME object directly, which needed three manual `.lastIndex = 0` resets to avoid leaking
  // match position between calls; a removed reset silently dropped the first chip (proven while
  // fixing this: temporarily deleting the pre-loop reset broke 5 tests above, incl. "renders a
  // single link as a chip"). It now holds its own instance (wiki-core.ts's newWikiLinkPattern
  // factory), so a dangling shared WikiLinkPattern can't affect it structurally, not just by
  // convention.
  it("is unaffected by another consumer's dangling WikiLinkPattern.lastIndex", () => {
    // Simulate a prior, unrelated caller (e.g. wiki-core.ts/lute-host.ts)
    // leaving the shared regex mid-match instead of exhausted.
    WikiLinkPattern.exec('[[Dangling]]')
    expect(WikiLinkPattern.lastIndex).not.toBe(0)

    const html = wikiTextToHtml('[[Page]]', true)
    expect(html).toContain('class="wiki-link-chip"')
    expect(html).toContain('data-wiki-target="Page"')

    WikiLinkPattern.lastIndex = 0
  })

  it('renders every link across repeated back-to-back calls', () => {
    for (let i = 0; i < 3; i++) {
      const html = wikiTextToHtml(`[[A${i}]] and [[B${i}]]`, true)
      expect(html.match(/wiki-link-chip/g)).toHaveLength(2)
    }
  })
})
