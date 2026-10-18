// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRealLute } from '../testing/real-lute'
import {
  applyBareUrls,
  applyBareUrlsWithin,
  observeBareUrls,
  setBareUrlsEnabled,
} from './bare-url-decorate'

// Task 655 — bare URLs are decorated in IR / WYSIWYG (class-only span, Lute-transparent) and in
// Preview / Split preview (real anchor, never serialized). Mirrors code-ref-decorate.test.ts.

const SPAN = 'span.vmde-bare-url[data-bare-url="1"]'
const ANCHOR = 'a.vmde-bare-url'

// Vditor's IR / WYSIWYG root is `<pre class="vditor-reset" contenteditable="true">` under `#app`.
function mountEditable(html: string): HTMLElement {
  const app = document.createElement('div')
  app.innerHTML = `<pre class="vditor-reset" contenteditable="true">${html}</pre>`
  document.body.appendChild(app)
  return app
}

// The Preview element is a plain read-only container (no contenteditable).
function mountPreview(html: string): HTMLElement {
  const preview = document.createElement('div')
  preview.className = 'vditor-preview__preview'
  preview.innerHTML = `<div class="vditor-reset">${html}</div>`
  document.body.appendChild(preview)
  return preview
}

function spans(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SPAN))
}

function htmlInline(token: string): string {
  return `<span data-type="html-inline" class="vditor-ir__node"><code class="vditor-ir__marker">${token}</code></span>`
}

beforeEach(() => {
  setBareUrlsEnabled(true)
})

afterEach(() => {
  setBareUrlsEnabled(true)
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})

describe('element shape (task 655 acceptance A2)', () => {
  it('wraps a bare URL in an editable surface with a class-only span and the href attribute', () => {
    const app = mountEditable(
      '<p data-block="0">Visit https://example.com today.</p>',
    )
    applyBareUrls(app)
    const [span] = spans(app)
    expect(span).toBeDefined()
    expect(span.textContent).toBe('https://example.com')
    expect(span.dataset.bareUrlHref).toBe('https://example.com')
    // Lute transparency (Fact 6): no data-render, no data-type, not focusable, not an editing island.
    expect(span.hasAttribute('data-render')).toBe(false)
    expect(span.hasAttribute('data-type')).toBe(false)
    expect(span.hasAttribute('contenteditable')).toBe(false)
    expect(span.hasAttribute('tabindex')).toBe(false)
    expect(app.querySelector('a')).toBeNull()
    expect(app.textContent).toBe('Visit https://example.com today.')
  })

  it('derives the href for www. and email matches and wraps several in one paragraph', () => {
    const app = mountEditable(
      '<p data-block="0">a www.b.org, mail x@y.io and https://c.com/p.</p>',
    )
    applyBareUrls(app)
    expect(
      spans(app).map((s) => [s.textContent, s.dataset.bareUrlHref]),
    ).toEqual([
      ['www.b.org', 'http://www.b.org'],
      ['x@y.io', 'mailto:x@y.io'],
      ['https://c.com/p', 'https://c.com/p'],
    ])
    expect(app.textContent).toBe(
      'a www.b.org, mail x@y.io and https://c.com/p.',
    )
  })

  it('uses a real anchor in the read-only Preview element, with no editor-only attributes', () => {
    const preview = mountPreview('<p>Visit https://example.com today.</p>')
    applyBareUrls(preview)
    const anchor = preview.querySelector<HTMLAnchorElement>(ANCHOR)
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('href')).toBe('https://example.com')
    expect(anchor?.textContent).toBe('https://example.com')
    expect(anchor?.hasAttribute('data-bare-url')).toBe(false)
    expect(preview.querySelector(SPAN)).toBeNull()
    expect(preview.textContent).toBe('Visit https://example.com today.')
  })

  it('uses http:// + text for a www. anchor and mailto: for an email anchor in Preview', () => {
    const preview = mountPreview('<p>www.b.org x@y.io</p>')
    applyBareUrls(preview)
    expect(
      Array.from(preview.querySelectorAll(ANCHOR)).map((a) =>
        a.getAttribute('href'),
      ),
    ).toEqual(['http://www.b.org', 'mailto:x@y.io'])
  })
})

describe('skip contexts (task 655: URLs in code, links, HTML, math are not decorated)', () => {
  const URL_TEXT = 'https://skip.example.com'
  const cases: Array<[string, string]> = [
    ['inline code', `<code>${URL_TEXT}</code>`],
    [
      'fenced code block',
      `<pre class="vditor-ir__marker--pre"><code>${URL_TEXT}</code></pre>`,
    ],
    [
      'WYSIWYG code block',
      `<pre class="vditor-wysiwyg__pre"><code>${URL_TEXT}</code></pre>`,
    ],
    ['real anchor', `<a href="https://x.org">${URL_TEXT}</a>`],
    [
      'IR link node',
      `<span data-type="a" class="vditor-ir__node"><span class="vditor-ir__link">${URL_TEXT}</span></span>`,
    ],
    ['link reference', `<span data-type="link-ref">${URL_TEXT}</span>`],
    [
      'link reference definitions',
      `<div data-type="link-ref-defs-block">${URL_TEXT}</div>`,
    ],
    ['inline html', `<span data-type="html-inline">${URL_TEXT}</span>`],
    ['html block', `<div data-type="html-block">${URL_TEXT}</div>`],
    ['html entity', `<span data-type="html-entity">${URL_TEXT}</span>`],
    ['inline math', `<span data-type="math-inline">${URL_TEXT}</span>`],
    ['math block', `<div data-type="math-block">${URL_TEXT}</div>`],
    ['IR marker', `<span class="vditor-ir__marker">${URL_TEXT}</span>`],
    ['IR preview', `<div class="vditor-ir__preview">${URL_TEXT}</div>`],
    ['rendered content', `<div data-render="1">${URL_TEXT}</div>`],
    ['footnote ref', `<sup data-type="footnotes-ref">${URL_TEXT}</sup>`],
    ['heading id', `<span data-type="heading-id">${URL_TEXT}</span>`],
    ['wiki chip', `<span data-wiki-link="1">${URL_TEXT}</span>`],
    ['code-ref chip', `<span data-code-ref="1">${URL_TEXT}</span>`],
    [
      'existing bare URL span',
      `<span class="vmde-bare-url" data-bare-url="1" data-bare-url-href="${URL_TEXT}">${URL_TEXT}</span>`,
    ],
    ['svg', `<svg><text>${URL_TEXT}</text></svg>`],
    ['comment text', `<span class="vmde-comment">${URL_TEXT}</span>`],
    [
      'Task 654 decorated raw anchor',
      `<span class="vmde-html-link" data-vmde-html-link="1" data-vmde-html-link-owner="1" data-vmde-html-link-href="https://x.org">${URL_TEXT}</span>`,
    ],
    [
      'Task 654 raw anchor body',
      `${htmlInline('&lt;a href="https://x.org"&gt;')}${URL_TEXT}${htmlInline('&lt;/a&gt;')}`,
    ],
  ]

  it.each(cases)(
    'leaves a URL inside %s plain in the editable surface',
    (_name, markup) => {
      const app = mountEditable(`<p data-block="0">${markup}</p>`)
      const before = app.innerHTML
      applyBareUrls(app)
      expect(app.innerHTML).toBe(before)
    },
  )

  it.each(cases.filter(([name]) => name !== 'existing bare URL span'))(
    'leaves a URL inside %s plain in Preview',
    (_name, markup) => {
      const preview = mountPreview(`<p>${markup}</p>`)
      const before = preview.innerHTML
      applyBareUrls(preview)
      expect(preview.innerHTML).toBe(before)
    },
  )

  it('leaves Split View source mode (.vditor-sv) alone', () => {
    const app = document.createElement('div')
    app.innerHTML = `<pre class="vditor-sv vditor-reset" contenteditable="true">see ${URL_TEXT}</pre>`
    document.body.appendChild(app)
    const before = app.innerHTML
    applyBareUrls(app)
    expect(app.innerHTML).toBe(before)
  })

  it('decorates a URL next to, but outside, a skipped context in the same paragraph', () => {
    const app = mountEditable(
      '<p data-block="0"><code>https://in.code.com</code> and https://out.example.com</p>',
    )
    applyBareUrls(app)
    expect(spans(app).map((s) => s.textContent)).toEqual([
      'https://out.example.com',
    ])
  })
})

describe('idempotence', () => {
  it('does not wrap an existing span again or change the DOM on a second pass', () => {
    const app = mountEditable(
      '<p data-block="0">Visit https://example.com and www.a.org.</p>',
    )
    applyBareUrls(app)
    const first = app.innerHTML
    applyBareUrls(app)
    applyBareUrlsWithin(app.querySelector('p')!)
    expect(app.innerHTML).toBe(first)
    expect(spans(app)).toHaveLength(2)
    expect(app.querySelector(`${SPAN} ${SPAN}`)).toBeNull()
  })

  it('does not wrap an existing Preview anchor again', () => {
    const preview = mountPreview('<p>Visit https://example.com.</p>')
    applyBareUrls(preview)
    const first = preview.innerHTML
    applyBareUrls(preview)
    expect(preview.innerHTML).toBe(first)
    expect(preview.querySelectorAll(ANCHOR)).toHaveLength(1)
  })
})

describe('caret-block skip', () => {
  function twoBlocks(): { app: HTMLElement; a: HTMLElement; b: HTMLElement } {
    const app = mountEditable(
      '<p data-block="0">one https://a.example.com</p><p data-block="1">two https://b.example.com</p>',
    )
    const [a, b] = Array.from(app.querySelectorAll<HTMLElement>('p'))
    return { app, a, b }
  }

  function placeCaret(node: Node, offset: number): void {
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  it('applyBareUrls decorates every block except the one holding the caret', () => {
    const { app, a, b } = twoBlocks()
    placeCaret(a.firstChild!, 5)
    applyBareUrls(app)
    expect(spans(a)).toHaveLength(0)
    expect(spans(b)).toHaveLength(1)
  })

  it('applyBareUrlsWithin (the scoped path a keystroke takes) respects the caret guard', () => {
    const { a } = twoBlocks()
    placeCaret(a.firstChild!, 5)
    applyBareUrlsWithin(a)
    expect(spans(a)).toHaveLength(0)
  })

  it('decorates the block once the caret has left it', () => {
    const { app, a, b } = twoBlocks()
    placeCaret(a.firstChild!, 5)
    applyBareUrls(app)
    placeCaret(b.firstChild!, 2)
    applyBareUrls(app)
    expect(spans(a)).toHaveLength(1)
    // A decoration made earlier stays when the caret later enters its block.
    expect(spans(b)).toHaveLength(1)
  })
})

describe('setting gate (Owner answer Q2: vmde.markdown.autolinkBareUrls)', () => {
  it('decorates nothing while disabled', () => {
    setBareUrlsEnabled(false)
    const app = mountEditable('<p data-block="0">https://example.com</p>')
    const preview = mountPreview('<p>https://example.com</p>')
    applyBareUrls(app)
    applyBareUrls(preview)
    applyBareUrlsWithin(app.querySelector('p')!)
    expect(app.querySelector('.vmde-bare-url')).toBeNull()
    expect(preview.querySelector('.vmde-bare-url')).toBeNull()
  })

  it('removes existing decoration from every observed pane on a live change, and restores it', () => {
    const app = mountEditable(
      '<p data-block="0">Visit https://example.com today.</p>',
    )
    const preview = mountPreview('<p>Visit https://example.com today.</p>')
    const disposeApp = observeBareUrls(app)
    const disposePreview = observeBareUrls(preview)
    try {
      expect(spans(app)).toHaveLength(1)
      expect(preview.querySelectorAll(ANCHOR)).toHaveLength(1)

      setBareUrlsEnabled(false)
      expect(app.querySelector('.vmde-bare-url')).toBeNull()
      expect(preview.querySelector('.vmde-bare-url')).toBeNull()
      expect(app.querySelector('p')?.innerHTML).toBe(
        'Visit https://example.com today.',
      )
      expect(preview.querySelector('p')?.innerHTML).toBe(
        'Visit https://example.com today.',
      )

      setBareUrlsEnabled(true)
      expect(spans(app)).toHaveLength(1)
      expect(preview.querySelectorAll(ANCHOR)).toHaveLength(1)
    } finally {
      disposeApp()
      disposePreview()
    }
  })

  it('stops reacting to a live change once the observer is disposed', () => {
    const app = mountEditable(
      '<p data-block="0">Visit https://example.com today.</p>',
    )
    const dispose = observeBareUrls(app)
    dispose()
    setBareUrlsEnabled(false)
    expect(spans(app)).toHaveLength(1) // not touched: the disposed observer no longer re-applies
  })
})

// The p4 corpus (Task 655 handoff, Fact 6): every block kind the serializers treat specially.
const CORPUS = `Visit https://example.com today.

https://example.com

www.example.com/a_b_c and user@example.com.

See https://example.com, then (https://example.com) and https://en.wikipedia.org/wiki/Foo_(bar).

# Heading https://example.com

## Heading with www.example.com/x

> quote https://example.com/path?q=1&r=2#frag

- item https://example.com
- item two www.example.com
  1. nested http://example.org/a-b

| a | b |
|---|---|
| https://example.com | www.x.org |

**https://example.com** and _https://example.com_ and ~~https://example.com~~

Inline \`https://example.com\` code and [text](https://example.com) and [https://a.com](https://a.com) and <https://b.com>.

\`\`\`
https://in-code-block.com
\`\`\`

$https://math.com$ text

Line one https://a.com
Line two https://b.com  
Line three hard break

https://example.com/a*b* emphasis inside

Footnote ref[^1] https://c.com

[^1]: Footnote with https://d.com

- [ ] task https://e.com
- [x] done www.f.com

Text with entity &amp; https://g.com/&lt;x&gt;

<span>html https://h.com</span>

Escaped \\_ https://i.com/a\\_b

https://j.com/~user/%20x?y=z+w
`

for (const mode of ['ir', 'wysiwyg'] as const) {
  describe(`serializer parity with real Lute (${mode}, task 655 acceptance A3)`, () => {
    const real = createRealLute(mode)
    const spin = (html: string): string =>
      mode === 'ir'
        ? real.lute.SpinVditorIRDOM(html)
        : real.lute.SpinVditorDOM(html)

    function mountCorpus(): HTMLElement {
      const app = document.createElement('div')
      const root = document.createElement('pre')
      root.className = 'vditor-reset'
      root.setAttribute('contenteditable', 'true')
      root.innerHTML = real.render(CORPUS)
      app.append(root)
      document.body.appendChild(app)
      return app
    }

    it('serialization and spin of the decorated DOM equal the plain DOM, byte for byte', () => {
      const app = mountCorpus()
      const root = app.querySelector<HTMLElement>('pre.vditor-reset')!
      const plainHtml = root.innerHTML
      const plainMd = real.serialize(plainHtml)
      const plainSpin = spin(plainHtml)

      applyBareUrls(app)

      expect(spans(root).length).toBeGreaterThan(20)
      expect(root.innerHTML).not.toBe(plainHtml)
      expect(real.serialize(root.innerHTML)).toBe(plainMd)
      expect(spin(root.innerHTML)).toBe(plainSpin)
      // Visible text is untouched too.
      const textBefore = (() => {
        const probe = document.createElement('div')
        probe.innerHTML = plainHtml
        return probe.textContent
      })()
      expect(root.textContent).toBe(textBefore)
    })

    it('never decorates a URL from code, math or an HTML tag token, but decorates text between inline HTML tags', () => {
      const app = mountCorpus()
      applyBareUrls(app)
      const decorated = spans(app).map((s) => s.textContent)
      for (const hidden of ['https://in-code-block.com', 'https://math.com'])
        expect(decorated.some((t) => t?.includes(hidden))).toBe(false)
      // `<span>html https://h.com</span>`: Lute emits the tags as html-inline nodes and the body as
      // plain sibling text, exactly what Preview renders as text inside a span, so it is linked.
      expect(decorated).toContain('https://h.com')
      // A bare URL in prose, a heading, a quote, a list item and a table cell is decorated.
      expect(decorated).toContain('https://example.com')
      expect(decorated).toContain('http://example.org/a-b')
      expect(decorated).toContain('www.x.org')
      expect(decorated).toContain('https://j.com/~user/%20x?y=z+w')
    })

    it('stays identical across a second pass over the decorated DOM', () => {
      const app = mountCorpus()
      applyBareUrls(app)
      const root = app.querySelector<HTMLElement>('pre.vditor-reset')!
      const once = root.innerHTML
      applyBareUrls(app)
      expect(root.innerHTML).toBe(once)
    })
  })
}
