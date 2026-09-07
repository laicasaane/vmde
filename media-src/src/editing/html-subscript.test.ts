// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  observeHtmlSubscripts,
  stripHtmlSubscriptPresentation,
  wrapHtmlSubscriptLute,
} from './html-subscript'

function root(html: string) {
  document.body.innerHTML = `<div id="root">${html}</div>`
  return document.querySelector<HTMLElement>('#root')!
}

afterEach(() => document.body.replaceChildren())

describe('HTML SUB reading presentation', () => {
  it('groups only proven source markers and reveals them when selection enters the owned SUB', () => {
    const app = root(
      '<p><span data-type="html-inline"><code>&lt;SUB title=\'kept\'&gt;</code></span><strong>2</strong><span data-type="html-inline"><code>&lt;/SUB&gt;</code></span></p>',
    )
    const dispose = observeHtmlSubscripts(app)
    const owned = app.querySelector('sub[data-vmde-html-subscript="1"]')!
    expect(owned.textContent).toBe('2')
    expect(owned.getAttribute('title')).toBeNull()
    expect(owned.previousElementSibling?.getAttribute('aria-hidden')).toBe(
      'true',
    )

    const text = owned.querySelector('strong')!.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    expect(app.querySelector('sub[data-vmde-html-subscript]')).toBeNull()
    expect(app.textContent).toContain("<SUB title='kept'>")

    const outside = document.createElement('p')
    outside.textContent = 'outside'
    app.append(outside)
    const outsideRange = document.createRange()
    outsideRange.setStart(outside.firstChild!, 0)
    outsideRange.collapse(true)
    selection.removeAllRanges()
    selection.addRange(outsideRange)
    document.dispatchEvent(new Event('selectionchange'))
    expect(app.querySelector('sub[data-vmde-html-subscript]')).not.toBeNull()
    dispose()
  })

  it('puts a pointer reveal caret in a direct text body after removing its owned wrapper', () => {
    const app = root(
      '<p>H<span data-type="html-inline">&lt;sub&gt;</span>2<span data-type="html-inline">&lt;/sub&gt;</span>O</p>',
    )
    const dispose = observeHtmlSubscripts(app)
    const owned = app.querySelector<HTMLElement>(
      'sub[data-vmde-html-subscript]',
    )!
    owned.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
    )
    const selection = getSelection()!
    expect(selection.anchorNode?.textContent).toBe('2')
    expect(selection.anchorOffset).toBeLessThanOrEqual(1)
    dispose()
  })

  it('leaves an empty marker body revealed so its caret stays in source markup', () => {
    const app = root(
      '<p>H<span data-type="html-inline">&lt;sub&gt;</span><span data-type="html-inline">&lt;/sub&gt;</span>O</p>',
    )
    const paragraph = app.querySelector('p')!
    const [open, close] = Array.from(
      paragraph.querySelectorAll('[data-type="html-inline"]'),
    )
    open.after(document.createTextNode(''))
    const dispose = observeHtmlSubscripts(app)
    const range = document.createRange()
    range.setStart(paragraph, 1)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    expect(app.querySelector('sub[data-vmde-html-subscript]')).toBeNull()
    expect((open as HTMLElement).style.display).toBe('')
    expect((close as HTMLElement).style.display).toBe('')
    expect(selection.anchorNode).toBe(paragraph)
    expect(selection.anchorOffset).toBe(1)
    dispose()
  })

  it('excludes malformed and code-context marker-looking content', () => {
    const app = root(
      '<p><span data-type="html-inline"><code>&lt;sub&gt;</code></span>open</p><pre><code><span data-type="html-inline">&lt;sub&gt;</span>x<span data-type="html-inline">&lt;/sub&gt;</span></code></pre>',
    )
    const dispose = observeHtmlSubscripts(app)
    expect(app.querySelector('sub[data-vmde-html-subscript]')).toBeNull()
    dispose()
  })

  it('keeps authored public-attribute collisions and rejects crossed tokens while admitting headings', () => {
    expect(
      stripHtmlSubscriptPresentation(
        '<p><sub data-vmde-html-subscript="1">authored</sub></p>',
      ),
    ).toContain('data-vmde-html-subscript="1"')
    const app = root(
      '<h2 data-block="0" class="vditor-ir__node" data-marker="#"><span class="vditor-ir__marker" data-type="heading-marker">## </span>H<span data-type="html-inline" class="vditor-ir__node"><code class="vditor-ir__marker">&lt;sub&gt;</code></span>2<span data-type="html-inline" class="vditor-ir__node"><code class="vditor-ir__marker">&lt;/sub&gt;</code></span>O</h2><p><span data-type="html-inline"><code>&lt;sub&gt;</code></span><span data-type="html-inline"><code>&lt;em&gt;</code></span>x<span data-type="html-inline"><code>&lt;/sub&gt;</code></span><span data-type="html-inline"><code>&lt;/em&gt;</code></span></p><p><code><span data-type="html-inline"><code>&lt;sub&gt;</code></span>x<span data-type="html-inline"><code>&lt;/sub&gt;</code></span></code></p>',
    )
    const dispose = observeHtmlSubscripts(app)
    expect(app.querySelector('h2 sub[data-vmde-html-subscript]')).not.toBeNull()
    expect(
      app.querySelectorAll('p sub[data-vmde-html-subscript]'),
    ).toHaveLength(0)
    dispose()
  })

  it('strips only owned presentation structure in a detached serializer input', () => {
    const app = root(
      '<p><span data-type="html-inline">&lt;sub&gt;</span>**2**<span data-type="html-inline">&lt;/sub&gt;</span></p>',
    )
    const dispose = observeHtmlSubscripts(app)
    expect(stripHtmlSubscriptPresentation(app.innerHTML)).not.toContain(
      'data-vmde-html-subscript',
    )
    dispose()
  })

  it('strips owned presentation before both serializers and both spins', () => {
    const calls = [
      vi.fn((html: string) => html),
      vi.fn((html: string) => html),
      vi.fn((html: string) => html),
      vi.fn((html: string) => html),
    ]
    const readers = {
      VditorIRDOM2Md: calls[0],
      VditorDOM2Md: calls[1],
      SpinVditorIRDOM: calls[2],
      SpinVditorDOM: calls[3],
    }
    wrapHtmlSubscriptLute(readers)
    const app = root(
      '<p><span data-type="html-inline">&lt;sub&gt;</span>2<span data-type="html-inline">&lt;/sub&gt;</span></p>',
    )
    const dispose = observeHtmlSubscripts(app)
    const html = app.innerHTML
    readers.VditorIRDOM2Md(html)
    readers.VditorDOM2Md(html)
    readers.SpinVditorIRDOM(html)
    readers.SpinVditorDOM(html)
    for (const reader of calls) {
      expect(reader).toHaveBeenCalledWith(
        expect.not.stringContaining('data-vmde-html-subscript'),
      )
    }
    dispose()
  })
})
