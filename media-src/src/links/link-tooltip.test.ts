// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createRealLute } from '../testing/real-lute'
import { applyBareUrls } from './bare-url-decorate'
import { wikiTextToHtml } from './custom-renderer'
import {
  imageTooltipText,
  installLinkTooltips,
  linkTooltipText,
  tooltipAt,
  unquoteMarkdownTitle,
} from './link-tooltip'

// Task 731 — links and images show their target as written on hover. The text builders are pure;
// the DOM reader and the hover wiring run against the vendored Lute's real IR, WYSIWYG and Preview
// output, and the round-trip cases prove that hovering writes nothing the serializer can read.

const SOURCE = [
  'Owner: [point 14](scoping-proposal.md#L674) end.',
  '',
  'Titled: [L-titled](b.md "Link Title") end.',
  '',
  'Ref: [L-ref][r1] and [L-short] end.',
  '',
  'Auto: <https://example.com/auto> end.',
  '',
  'Bare: https://bare.example/x end.',
  '',
  'Escaped: [L-esc](a\\(b\\).md) and [L-pct](my%20file.md) end.',
  '',
  'Image: ![Alt text](pic.png "Image Title") end.',
  '',
  'Alt only: ![Only alt](alt.png) end.',
  '',
  'Same: ![Same](same.png "Same") end.',
  '',
  'Linked: [![Inner alt](inner.png) caption](https://example.com/outer) end.',
  '',
  '[r1]: https://example.com/ref',
  '[L-short]: short.md',
  '',
].join('\n')

type Surface = 'ir' | 'wysiwyg' | 'preview'

afterEach(() => {
  document.body.innerHTML = ''
  document.body.removeAttribute('title')
  window.getSelection()?.removeAllRanges()
})

function mount(surface: Surface, html: string): HTMLElement {
  const container = document.createElement('div')
  container.className = {
    ir: 'vditor-ir',
    wysiwyg: 'vditor-wysiwyg',
    preview: 'vditor-preview',
  }[surface]
  const root = document.createElement(surface === 'preview' ? 'div' : 'pre')
  root.className = 'vditor-reset'
  if (surface !== 'preview') root.setAttribute('contenteditable', 'true')
  root.innerHTML = html
  container.append(root)
  document.body.append(container)
  return root
}

const luteIr = createRealLute('ir')
const luteWysiwyg = createRealLute('wysiwyg')

function render(surface: Surface, markdown: string): HTMLElement {
  const html =
    surface === 'ir'
      ? luteIr.render(markdown)
      : surface === 'wysiwyg'
        ? luteWysiwyg.render(markdown)
        : luteIr.lute.Md2HTML(markdown)
  const root = mount(surface, html)
  applyBareUrls(root)
  return root
}

// The element holding the visible text `text` (never an IR marker, which is hidden at rest).
function textElement(root: HTMLElement, text: string): HTMLElement {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.replace(/\u200b/g, '').trim() !== text) continue
    if (node.parentElement?.closest('.vditor-ir__marker')) continue
    return node.parentElement as HTMLElement
  }
  throw new Error(`no text ${text}`)
}

function imageElement(root: HTMLElement, src: string): HTMLElement {
  const image = root.querySelector<HTMLElement>(`img[src="${src}"]`)
  if (!image) throw new Error(`no image ${src}`)
  return image
}

// What the browser shows: the nearest ancestor-or-self `title`.
function effectiveTitle(element: Element): string | null {
  for (let at: Element | null = element; at; at = at.parentElement) {
    const title = at.getAttribute('title')
    if (title) return title
  }
  return null
}

function hover(element: Element): void {
  element.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
  element.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
}

function leaveDocument(element: Element): void {
  element.dispatchEvent(
    new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }),
  )
}

describe('linkTooltipText', () => {
  it('shows the destination exactly as written (the Owner example)', () => {
    expect(linkTooltipText(null, 'scoping-proposal.md#L674')).toBe(
      'scoping-proposal.md#L674',
    )
  })

  it('puts a Markdown title on the first line and the destination on the second', () => {
    expect(linkTooltipText('Title', 'b.md')).toBe('Title\nb.md')
  })

  it('keeps escapes, percent-encoding and entities as written', () => {
    expect(linkTooltipText(null, 'a\\(b\\).md')).toBe('a\\(b\\).md')
    expect(linkTooltipText(null, 'my%20file.md')).toBe('my%20file.md')
    expect(linkTooltipText(null, 'a&amp;b.md')).toBe('a&amp;b.md')
  })

  it('is CRLF-free: a title with CR or CRLF breaks becomes LF lines', () => {
    const text = linkTooltipText('one\r\ntwo\rthree', 'b.md')
    expect(text).toBe('one\ntwo\nthree\nb.md')
    expect(text).not.toContain('\r')
  })

  it('omits empty parts and gives null when nothing is left', () => {
    expect(linkTooltipText('', 'b.md')).toBe('b.md')
    expect(linkTooltipText('Title', '')).toBe('Title')
    expect(linkTooltipText(null, '')).toBeNull()
    expect(linkTooltipText(null, '\u200b')).toBeNull()
  })
})

describe('imageTooltipText', () => {
  it('shows title, alt text and target, the target last', () => {
    expect(imageTooltipText('Caption', 'Alt', 'pic.png')).toBe(
      'Caption\nAlt\npic.png',
    )
  })

  it('shows only the parts that exist', () => {
    expect(imageTooltipText(null, 'Alt', 'pic.png')).toBe('Alt\npic.png')
    expect(imageTooltipText('Caption', '', 'pic.png')).toBe('Caption\npic.png')
    expect(imageTooltipText(null, null, 'pic.png')).toBe('pic.png')
    expect(imageTooltipText(null, null, '')).toBeNull()
  })

  it('shows the same title and alt text once (D5)', () => {
    expect(imageTooltipText('Same', 'Same', 'pic.png')).toBe('Same\npic.png')
    expect(imageTooltipText('Same', 'same', 'pic.png')).toBe(
      'Same\nsame\npic.png',
    )
  })

  it('keeps the target as written and is CRLF-free', () => {
    expect(imageTooltipText('a\r\nb', null, 'my%20pic\\_1.png')).toBe(
      'a\nb\nmy%20pic\\_1.png',
    )
  })
})

describe('unquoteMarkdownTitle', () => {
  it('removes the delimiters and resolves backslash escapes', () => {
    expect(unquoteMarkdownTitle('"Title"')).toBe('Title')
    expect(unquoteMarkdownTitle("'Title'")).toBe('Title')
    expect(unquoteMarkdownTitle('(Title)')).toBe('Title')
    expect(unquoteMarkdownTitle('"x \\"y\\""')).toBe('x "y"')
  })
})

// Expected tooltip per visible text (or image src), the same on every surface. The reader computes
// the full text even where the hover wiring cannot show it (a WYSIWYG link or image keeps its own
// Markdown `title`; see the round-trip cases below).
const LINKS: Array<[string, string]> = [
  ['point 14', 'scoping-proposal.md#L674'],
  ['L-titled', 'Link Title\nb.md'],
  ['L-ref', 'https://example.com/ref'],
  ['L-short', 'short.md'],
  ['https://example.com/auto', 'https://example.com/auto'],
  ['https://bare.example/x', 'https://bare.example/x'],
  ['L-pct', 'my%20file.md'],
  ['caption', 'https://example.com/outer'],
]
const IMAGES: Array<[string, string]> = [
  ['pic.png', 'Image Title\nAlt text\npic.png'],
  ['alt.png', 'Only alt\nalt.png'],
  ['same.png', 'Same\nsame.png'],
  ['inner.png', 'Inner alt\ninner.png'],
]
// Preview shows the raw href attribute Lute rendered. Md2HTML on the edit-mode Lute instance (the
// one Vditor's Preview uses) keeps the backslash escapes as written.
const ESCAPED: Record<Surface, string> = {
  ir: 'a\\(b\\).md',
  wysiwyg: 'a\\(b\\).md',
  preview: 'a\\(b\\).md',
}

describe.each(['ir', 'wysiwyg', 'preview'] as const)(
  'tooltipAt on the real %s DOM',
  (surface) => {
    it.each(LINKS)('link %s', (text, expected) => {
      const root = render(surface, SOURCE)
      const tip = tooltipAt(textElement(root, text))
      expect(tip?.text).toBe(expected)
      expect(tip?.surface).toBe(surface === 'preview' ? 'preview' : 'editor')
    })

    it('escaped link destination', () => {
      const root = render(surface, SOURCE)
      expect(tooltipAt(textElement(root, 'L-esc'))?.text).toBe(ESCAPED[surface])
    })

    it.each(IMAGES)('image %s', (src, expected) => {
      const root = render(surface, SOURCE)
      expect(tooltipAt(imageElement(root, src))?.text).toBe(expected)
    })

    it('plain text and the reference definition show nothing', () => {
      const root = render(surface, SOURCE)
      expect(tooltipAt(textElement(root, 'Owner:'))).toBeNull()
      if (surface !== 'preview') {
        const defs = root.querySelector('[data-type="link-ref-defs-block"]')
        expect(tooltipAt(defs)).toBeNull()
      }
    })
  },
)

describe('tooltipAt edge shapes', () => {
  it('reads IR markers when the caret has revealed a link source', () => {
    const root = render('ir', SOURCE)
    const node = textElement(root, 'L-titled').closest('[data-type="a"]')!
    const marker = node.querySelector('.vditor-ir__marker--link')!
    expect(tooltipAt(marker)?.text).toBe('Link Title\nb.md')
  })

  it('answers for the link, not its image, on the outer link marker', () => {
    const root = render('ir', SOURCE)
    const outer = textElement(root, 'caption').closest('[data-type="a"]')!
    const marker = outer.querySelector(':scope > .vditor-ir__marker--link')!
    expect(tooltipAt(marker)?.text).toBe('https://example.com/outer')
  })

  it('leaves wiki chips and their own "Open wiki page" title alone', () => {
    const chips = wikiTextToHtml(
      'see [[Page#Heading|Label]] and [[Missing]]',
      true,
      new Set(['page-heading']),
    )
    const root = mount('ir', `<p data-block="0">${chips}</p>`)
    for (const chip of root.querySelectorAll('[data-wiki-link="1"]'))
      expect(tooltipAt(chip)).toBeNull()
  })

  it('shows a decorated raw HTML anchor its href', () => {
    const root = mount(
      'ir',
      '<p data-block="0"><span data-vmde-html-link="1" data-vmde-html-link-owner="t" data-vmde-html-link-href="https://example.com/html">L-html</span></p>',
    )
    expect(tooltipAt(textElement(root, 'L-html'))?.text).toBe(
      'https://example.com/html',
    )
  })

  it('ignores the source pane and renderer output', () => {
    const sv = document.createElement('pre')
    sv.className = 'vditor-sv vditor-reset'
    sv.innerHTML = '<a href="x.md">sv</a>'
    document.body.append(sv)
    expect(tooltipAt(sv.querySelector('a'))).toBeNull()
    const root = mount(
      'preview',
      '<div class="language-plantuml"><img src="data:image/png;base64,AA" alt="d"></div>',
    )
    expect(tooltipAt(root.querySelector('img'))).toBeNull()
  })
})

const ROUND_TRIP_SOURCE = [
  'Owner: [point 14](scoping-proposal.md#L674) end.',
  '',
  'Titled: [L-titled](b.md "Link Title") end.',
  '',
  'Ref: [L-ref][r1] end.',
  '',
  'Bare: https://bare.example/x end.',
  '',
  'Image: ![Alt text](pic.png "Image Title") end.',
  '',
  'Alt only: ![Only alt](alt.png) end.',
  '',
  'Linked: [![Inner alt](inner.png) caption](https://example.com/outer) end.',
  '',
  '[r1]: https://example.com/ref',
  '',
].join('\n')

describe.each(['ir', 'wysiwyg'] as const)(
  'hovering in %s writes nothing the serializer or Undo can read',
  (surface) => {
    const lute = surface === 'ir' ? luteIr : luteWysiwyg

    it('the saved Markdown and the editor DOM stay byte-identical while each tooltip shows', () => {
      const root = render(surface, ROUND_TRIP_SOURCE)
      const savedBefore = lute.serialize(root.innerHTML)
      const htmlBefore = root.innerHTML
      const records: MutationRecord[] = []
      const observer = new MutationObserver((batch) => records.push(...batch))
      observer.observe(root.parentElement as HTMLElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      })
      // A caret in the first paragraph must not move.
      const caretText = textElement(root, 'point 14').firstChild as Text
      const range = document.createRange()
      range.setStart(caretText, 2)
      range.collapse(true)
      window.getSelection()?.addRange(range)
      const dispose = installLinkTooltips(document)
      const expected: Array<[HTMLElement, string]> = [
        [textElement(root, 'point 14'), 'scoping-proposal.md#L674'],
        [
          textElement(root, 'L-titled'),
          surface === 'ir' ? 'Link Title\nb.md' : 'Link Title',
        ],
        [textElement(root, 'L-ref'), 'https://example.com/ref'],
        [textElement(root, 'https://bare.example/x'), 'https://bare.example/x'],
        [
          imageElement(root, 'pic.png'),
          surface === 'ir' ? 'Image Title\nAlt text\npic.png' : 'Image Title',
        ],
        [imageElement(root, 'alt.png'), 'Only alt\nalt.png'],
        [imageElement(root, 'inner.png'), 'Inner alt\ninner.png'],
        [textElement(root, 'caption'), 'https://example.com/outer'],
      ]
      // The bare-URL decoration wrote its span before the observer; drop nothing else.
      records.length = 0
      for (const [element, text] of expected) {
        hover(element)
        expect(effectiveTitle(element)).toBe(text)
        expect(lute.serialize(root.innerHTML)).toBe(savedBefore)
      }
      leaveDocument(root)
      expect(document.body.hasAttribute('title')).toBe(false)
      dispose()
      observer.disconnect()
      expect(records).toEqual([])
      expect(root.innerHTML).toBe(htmlBefore)
      expect(lute.serialize(root.innerHTML)).toBe(savedBefore)
      const selection = window.getSelection()
      expect(selection?.anchorNode).toBe(caretText)
      expect(selection?.anchorOffset).toBe(2)
    })

    it('a WYSIWYG title attribute would leak: the reason tooltips never go on the element', () => {
      if (surface !== 'wysiwyg') return
      const root = render(surface, 'A [L](b.md) end.\n')
      const anchor = root.querySelector('a') as HTMLElement
      anchor.setAttribute('title', 'b.md')
      expect(lute.serialize(root.innerHTML)).toBe('A [L](b.md "b.md") end.\n')
    })
  },
)

describe('hover wiring', () => {
  it('Preview: replaces a Markdown title while hovered and restores it on leave', () => {
    const root = render('preview', SOURCE)
    const dispose = installLinkTooltips(document)
    const titled = textElement(root, 'L-titled')
    hover(titled)
    expect(titled.getAttribute('title')).toBe('Link Title\nb.md')
    expect(document.body.hasAttribute('title')).toBe(false)
    const image = imageElement(root, 'pic.png')
    hover(image)
    expect(titled.getAttribute('title')).toBe('Link Title')
    expect(image.getAttribute('title')).toBe('Image Title\nAlt text\npic.png')
    const plain = textElement(root, 'point 14')
    hover(plain)
    expect(image.getAttribute('title')).toBe('Image Title')
    expect(plain.getAttribute('title')).toBe('scoping-proposal.md#L674')
    leaveDocument(plain)
    expect(plain.hasAttribute('title')).toBe(false)
    dispose()
  })

  it('Preview: an image inside a titled link shows its own tooltip', () => {
    const root = render(
      'preview',
      '[![Inner](i.png "It")](https://example.com/o "Lt")\n',
    )
    const dispose = installLinkTooltips(document)
    const image = imageElement(root, 'i.png')
    hover(image)
    expect(effectiveTitle(image)).toBe('It\nInner\ni.png')
    dispose()
    expect(image.getAttribute('title')).toBe('It')
  })

  it('keeps a Preview title that a re-render replaced while hovered', () => {
    const root = render('preview', SOURCE)
    const dispose = installLinkTooltips(document)
    const titled = textElement(root, 'L-titled')
    hover(titled)
    titled.setAttribute('title', 'Re-rendered')
    hover(textElement(root, 'Owner:'))
    expect(titled.getAttribute('title')).toBe('Re-rendered')
    dispose()
  })

  it('a key press, a pointer press, an edit and a scroll drop the tooltip', () => {
    const root = render('ir', SOURCE)
    const dispose = installLinkTooltips(document)
    const link = textElement(root, 'point 14')
    for (const event of [
      new KeyboardEvent('keydown', { bubbles: true }),
      new MouseEvent('pointerdown', { bubbles: true }),
      new Event('input', { bubbles: true }),
      new Event('scroll'),
    ]) {
      hover(link)
      expect(document.body.getAttribute('title')).toBe(
        'scoping-proposal.md#L674',
      )
      link.dispatchEvent(event)
      expect(document.body.hasAttribute('title')).toBe(false)
    }
    dispose()
  })

  it('leaves a body title it did not write, and stops on dispose', () => {
    const root = render('ir', SOURCE)
    const dispose = installLinkTooltips(document)
    const link = textElement(root, 'point 14')
    hover(link)
    document.body.setAttribute('title', 'someone else')
    leaveDocument(link)
    expect(document.body.getAttribute('title')).toBe('someone else')
    document.body.removeAttribute('title')
    dispose()
    hover(textElement(root, 'L-pct'))
    expect(document.body.hasAttribute('title')).toBe(false)
  })
})
