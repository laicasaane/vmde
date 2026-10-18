// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { htmlAnchorHref, htmlLinkHrefAt } from './html-link'

afterEach(() => document.body.replaceChildren())

describe('htmlAnchorHref (Task 654 recognition table)', () => {
  // Expected values come from Preview's behaviour: the browser attribute decoding of the authored
  // token, and the sanitizer rule that drops javascript:, data:text/html and data:image/svg+xml.
  it.each([
    ['https', '<a href="https://example.com">', 'https://example.com'],
    ['relative', '<a href="./target.md">', './target.md'],
    ['fragment', '<a href="#x">', '#x'],
    ['mailto', '<a href="mailto:a@b.c">', 'mailto:a@b.c'],
    ['vbscript (kept by Preview)', '<a href="vbscript:x">', 'vbscript:x'],
    [
      'data:image/png',
      '<a href="data:image/png;base64,AA">',
      'data:image/png;base64,AA',
    ],
    ['empty href', '<a href="">', ''],
    ['single quotes', "<a href='https://e.com/s'>", 'https://e.com/s'],
    ['uppercase', '<A HREF="https://e.com/u">', 'https://e.com/u'],
    [
      'three attributes',
      '<a class="x" href="https://e.com/3" title="t">',
      'https://e.com/3',
    ],
    ['entity decoded', '<a href="?a=1&amp;b=2">', '?a=1&b=2'],
    ['leading ZWSP', '\u200b<a href="https://e.com/z">', 'https://e.com/z'],
  ])('decorates %s', (_name, token, href) => {
    expect(htmlAnchorHref(token)).toBe(href)
  })

  it.each([
    ['no href', '<a>'],
    ['id only', '<a id="x">'],
    ['name only', '<a name="y">'],
    ['javascript', '<a href="javascript:alert(1)">'],
    ['leading spaces', '<a href="  javascript:alert(1)">'],
    ['mixed case', '<a href="JaVaScRiPt:alert(1)">'],
    ['numeric entity', '<a href="jav&#97;script:alert(1)">'],
    ['tab entity', '<a href="java&#x09;script:alert(1)">'],
    ['no-break space', '<a href="java\u00a0script:alert(1)">'],
    ['leading no-break space', '<a href="\u00a0javascript:alert(1)">'],
    ['ideographic space', '<a href="java\u3000script:alert(1)">'],
    ['data text/html', '<a href="data:text/html,x">'],
    ['data svg', '<a href="data:image/svg+xml,x">'],
    ['closing tag', '</a>'],
    ['other tag', '<b href="https://e.com">'],
    ['not a tag', 'a href="https://e.com"'],
  ])('leaves %s as source', (_name, token) => {
    expect(htmlAnchorHref(token)).toBeNull()
  })
})

function para(html: string): HTMLElement {
  document.body.innerHTML = `<p id="p">${html}</p>`
  return document.getElementById('p')!
}
function marker(text: string): string {
  return `<span data-type="html-inline" class="vditor-ir__node"><code class="vditor-ir__marker">${text}</code></span>`
}
const OPEN = marker('&lt;a href=&quot;https://e.com/a&quot;&gt;')
const OPEN2 = marker('&lt;a href=&quot;https://e.com/b&quot;&gt;')
const CLOSE = marker('&lt;/a&gt;')

describe('htmlLinkHrefAt (Task 654 caret lookup)', () => {
  it('finds the href from a text node in the body', () => {
    const p = para(`x ${OPEN}body${CLOSE} y`)
    expect(htmlLinkHrefAt(p.childNodes[2])).toBe('https://e.com/a')
  })

  it('finds the href from a node nested in the body', () => {
    const p = para(`${OPEN}a <em>deep</em> b${CLOSE}`)
    expect(htmlLinkHrefAt(p.querySelector('em')!.firstChild)).toBe(
      'https://e.com/a',
    )
  })

  it('returns null outside the pair', () => {
    const p = para(`before ${OPEN}body${CLOSE} after`)
    expect(htmlLinkHrefAt(p.firstChild)).toBeNull()
    expect(htmlLinkHrefAt(p.lastChild)).toBeNull()
  })

  it('returns null on a marker itself', () => {
    const p = para(`${OPEN}body${CLOSE}`)
    expect(htmlLinkHrefAt(p.querySelector('code'))).toBeNull()
    expect(htmlLinkHrefAt(p.querySelector('code')!.firstChild)).toBeNull()
  })

  it('picks the right link when there are two', () => {
    const p = para(`${OPEN}one${CLOSE} mid ${OPEN2}two${CLOSE}`)
    const texts = Array.from(p.childNodes).filter(
      (n) => n.nodeType === Node.TEXT_NODE,
    )
    expect(htmlLinkHrefAt(texts[0])).toBe('https://e.com/a')
    expect(htmlLinkHrefAt(texts[1])).toBeNull()
    expect(htmlLinkHrefAt(texts[2])).toBe('https://e.com/b')
  })

  it('returns null for an unclosed anchor', () => {
    const p = para(`${OPEN}body no close`)
    expect(htmlLinkHrefAt(p.childNodes[1])).toBeNull()
  })

  it('returns null when the open anchor has no accepted href', () => {
    const p = para(`${marker('&lt;a id=&quot;x&quot;&gt;')}body${CLOSE}`)
    expect(htmlLinkHrefAt(p.childNodes[1])).toBeNull()
  })

  const SPAN =
    '<span data-vmde-html-link="1" data-vmde-html-link-owner="o:1" data-vmde-html-link-href="https://e.com/d">t</span>'

  it('reads the href of a decorated owned span in the editor', () => {
    document.body.innerHTML = `<div class="vditor-ir"><p>${SPAN}</p></div>`
    expect(htmlLinkHrefAt(document.querySelector('span')!.firstChild)).toBe(
      'https://e.com/d',
    )
  })

  it.each([
    ['preview', `<div class="vditor-preview"><p>${SPAN}</p></div>`],
    [
      'rendered block',
      `<div class="vditor-ir"><pre data-render="2"><p>${SPAN}</p></pre></div>`,
    ],
    [
      'no owner',
      `<div class="vditor-ir"><p>${SPAN.replace(' data-vmde-html-link-owner="o:1"', '')}</p></div>`,
    ],
    ['outside the editor', `<p>${SPAN}</p>`],
  ])('does not trust an authored span (%s)', (_name, html) => {
    document.body.innerHTML = html
    expect(
      htmlLinkHrefAt(document.querySelector('span')!.firstChild),
    ).toBeNull()
  })

  it('returns null for null and for a node outside any paragraph', () => {
    expect(htmlLinkHrefAt(null)).toBeNull()
    expect(htmlLinkHrefAt(document.body)).toBeNull()
  })
})
