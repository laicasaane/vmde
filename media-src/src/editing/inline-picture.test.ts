// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import {
  buildInlinePictureMarkup,
  observeInlinePictures,
  planInlinePictureInsertion,
} from './inline-picture'

function root(html: string) {
  document.body.innerHTML = `<div id="root">${html}</div>`
  return document.querySelector<HTMLElement>('#root')!
}

afterEach(() => document.body.replaceChildren())

describe('inline PICTURE source insertion', () => {
  it('generates ordered dark/light sources with escaped source-faithful attributes', () => {
    expect(
      buildInlinePictureMarkup({
        fallback: 'assets/light image.png?one=1&two=2',
        alt: 'A "bright" <example>',
        dark: 'https://cdn.example.test/dark.webp',
        light: './light.png',
      }),
    ).toBe(
      '<picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.example.test/dark.webp"><source media="(prefers-color-scheme: light)" srcset="./light.png"><img src="assets/light image.png?one=1&amp;two=2" alt="A &quot;bright&quot; &lt;example&gt;"></picture>',
    )
  })

  it('rejects missing fallback and non-raster or unsafe image locations', () => {
    for (const input of [
      { fallback: '', alt: '', dark: '', light: '' },
      { fallback: 'photo.svg', alt: '', dark: '', light: '' },
      { fallback: 'javascript:alert(1).png', alt: '', dark: '', light: '' },
      {
        fallback: 'https://example.test/photo.png',
        alt: '',
        dark: 'data:image/png;base64,x',
        light: '',
      },
    ])
      expect(buildInlinePictureMarkup(input)).toBeNull()
  })

  it('splices exactly one generated PICTURE into the canonical source without changing CRLF bytes', () => {
    expect(
      planInlinePictureInsertion('before\r\nafter\r\n', 8, {
        fallback: 'light.png',
        alt: 'Light',
        dark: '',
        light: '',
      }),
    ).toEqual({
      markdown:
        'before\r\n<picture><img src="light.png" alt="Light"></picture>after\r\n',
      caret: 60,
    })
  })
})

describe('inline PICTURE reader', () => {
  it('replaces one safe marker sequence with a Lute-invisible picture and leaves authored source markers intact', () => {
    const app = root(
      '<p>Text <span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;source media="(prefers-color-scheme: dark)" srcset="dark.png"&gt;</span><span data-type="html-inline">&lt;img src="light.png" alt="Example"&gt;</span><span data-type="html-inline">&lt;/picture&gt;</span> text.</p>',
    )
    const dispose = observeInlinePictures(app)
    const preview = app.querySelector<HTMLElement>(
      'picture[data-vmde-inline-picture="1"]',
    )!

    expect(preview.getAttribute('data-render')).toBe('1')
    expect(preview.getAttribute('contenteditable')).toBe('false')
    expect(preview.querySelector('source')?.getAttribute('srcset')).toBe(
      'dark.png',
    )
    expect(preview.querySelector('img')?.getAttribute('src')).toBe('light.png')
    expect(preview.querySelector('img')?.getAttribute('alt')).toBe('Example')
    expect(
      Array.from(app.querySelectorAll('[data-type="html-inline"]')).every(
        (marker) => (marker as HTMLElement).style.display === 'none',
      ),
    ).toBe(true)
    expect(app.textContent).toContain('<picture>')
    expect(app.textContent).toContain('light.png')
    dispose()
  })

  it('reveals the original markup on pointer entry and restores the render after focus leaves', () => {
    const app = root(
      '<p>x<span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;img src="photo.png" alt="Photo"&gt;</span><span data-type="html-inline">&lt;/picture&gt;</span>y</p>',
    )
    const dispose = observeInlinePictures(app)
    const preview = app.querySelector<HTMLElement>(
      '[data-vmde-inline-picture]',
    )!
    preview.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
    )

    expect(app.querySelector('[data-vmde-inline-picture]')).toBeNull()
    expect(
      Array.from(app.querySelectorAll('[data-type="html-inline"]')).every(
        (marker) => (marker as HTMLElement).style.display === '',
      ),
    ).toBe(true)

    const outside = document.createElement('p')
    outside.textContent = 'outside'
    app.append(outside)
    const range = document.createRange()
    range.setStart(outside.firstChild!, 0)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    expect(app.querySelector('[data-vmde-inline-picture]')).not.toBeNull()
    dispose()
  })

  it('fails closed for malformed, unsafe, and literal-code marker sequences', () => {
    const app = root(
      '<p><span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;img src="vector.svg" alt="Vector"&gt;</span><span data-type="html-inline">&lt;/picture&gt;</span></p><p><span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;img src="photo.png" alt="Photo"&gt;</span></p><pre><code><span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;img src="photo.png" alt="Photo"&gt;</span><span data-type="html-inline">&lt;/picture&gt;</span></code></pre>',
    )
    const dispose = observeInlinePictures(app)
    expect(app.querySelector('[data-vmde-inline-picture]')).toBeNull()
    dispose()
  })
})
