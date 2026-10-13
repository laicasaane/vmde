import { describe, expect, it } from 'vitest'
import {
  reintroduceChips,
  rewriteWikiChipsToSource,
  setKnownPagesRef,
} from './wiki-serialize'

describe('rewriteWikiChipsToSource', () => {
  const chip = (target: string, source: string, label?: string, extra = '') =>
    `<span class="wiki-link-chip" data-wiki-link="1" data-wiki-target="${target}" data-wiki-source="${source}"${extra} title="Open wiki page ${target}">${label ?? target}</span>`

  it('replaces a simple wiki chip with its [[source]]', () => {
    const html = `<p>See ${chip('Home', '[[Home]]')} here.</p>`
    expect(rewriteWikiChipsToSource(html)).toBe('<p>See [[Home]] here.</p>')
  })

  it('handles pipe syntax: [[Target|Label]] round-trips correctly', () => {
    const html = `<p>${chip('Target', '[[Target|Display Label]]', 'Display Label')}</p>`
    expect(rewriteWikiChipsToSource(html)).toBe(
      '<p>[[Target|Display Label]]</p>',
    )
  })

  it('handles multiple chips in one block', () => {
    const html = `<p>${chip('A', '[[A]]')} and ${chip('B', '[[B]]')} and ${chip('C', '[[C]]')}</p>`
    expect(rewriteWikiChipsToSource(html)).toBe(
      '<p>[[A]] and [[B]] and [[C]]</p>',
    )
  })

  it('handles missing-page chips (data-wiki-missing="1")', () => {
    const html = `<p>${chip('Missing', '[[Missing]]', undefined, ' data-wiki-missing="1"')}</p>`
    expect(rewriteWikiChipsToSource(html)).toBe('<p>[[Missing]]</p>')
  })

  it('unescapes HTML entities in data-wiki-source', () => {
    const html = chip('A&amp;B', '[[A&amp;B]]', 'A&amp;B')
    expect(rewriteWikiChipsToSource(html)).toBe('[[A&B]]')
  })

  it('does not touch non-wiki spans', () => {
    const html = '<p><span class="other">text</span></p>'
    expect(rewriteWikiChipsToSource(html)).toBe(html)
  })

  it('does not touch HTML without wiki chips', () => {
    const html = '<p>Just plain **bold** text</p>'
    expect(rewriteWikiChipsToSource(html)).toBe(html)
  })

  it('handles chip inside bold/emphasis wrappers', () => {
    const html = `<p><strong>see ${chip('Page', '[[Page]]')}</strong></p>`
    expect(rewriteWikiChipsToSource(html)).toBe(
      '<p><strong>see [[Page]]</strong></p>',
    )
  })

  it('preserves a <wbr> caret marker inside a chip, placing it after the source', () => {
    // Caret clicked into the trailing chip's text → <wbr> lands inside the span.
    const html = `<p>kh [[CLI]] <span class="wiki-link-chip" data-wiki-link="1" data-wiki-target="API" data-wiki-source="[[API]]" title="Open wiki page API">API <wbr></span></p>`
    expect(rewriteWikiChipsToSource(html)).toBe(
      '<p>kh [[CLI]] [[API]]<wbr></p>',
    )
  })

  it('consumes a trailing zero-width space after a chip', () => {
    const html = `<p>${chip('Home', '[[Home]]')}​ more</p>`
    expect(rewriteWikiChipsToSource(html)).toBe('<p>[[Home]] more</p>')
  })

  it('keeps a <wbr> that sits AFTER the chip untouched', () => {
    const html = `<p>${chip('Home', '[[Home]]')}<wbr> x</p>`
    expect(rewriteWikiChipsToSource(html)).toBe('<p>[[Home]]<wbr> x</p>')
  })
})

// Task 457 — reintroduceChips is the SECOND independent chip-HTML generator (fires after
// SpinVditorIRDOM re-parses an edited block, regenerating the chip a keystroke just touched) — it
// must carry the SAME markup shape as the primary renderer (custom-renderer.test.ts, including the
// deliberate absence of tabindex — see that test's comment), or a chip's activation would drift the
// moment the user edits its block.
describe('reintroduceChips', () => {
  it('re-renders a [[wiki]] source back into a chip, without a tabindex', () => {
    const html = reintroduceChips('see [[Page]] here')
    expect(html).toContain('class="wiki-link-chip"')
    expect(html).not.toContain('tabindex')
    expect(html).toContain('data-wiki-target="Page"')
  })

  it('keeps wiki-shaped text literal inside inline code', () => {
    const html =
      '<p>Wiki-style <span data-type="code"><code>[[links]]</code></span> and [[Page]].</p>'

    const rendered = reintroduceChips(html)

    expect(rendered).toContain('<code>[[links]]</code>')
    expect(rendered).not.toContain('data-wiki-target="links"')
    expect(rendered).toContain('data-wiki-target="Page"')
  })

  it('flags a chip missing only once the known-page getter returns a set', () => {
    let known: Set<string> | undefined
    setKnownPagesRef(() => known)
    try {
      // Keys still loading: the getter yields nothing, so nothing is flagged.
      expect(reintroduceChips('[[Gone]]')).not.toContain('data-wiki-missing')
      known = new Set(['home'])
      expect(reintroduceChips('[[Gone]]')).toContain('data-wiki-missing="1"')
      expect(reintroduceChips('[[Home]]')).not.toContain('data-wiki-missing')
    } finally {
      setKnownPagesRef(undefined)
    }
  })
})
