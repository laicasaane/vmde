// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { withoutOwnHintRecords } from '../util/wrap-hint-mark'
import {
  inlineCodesWithin,
  installWrapHints,
  readHintOffsets,
  rewriteHints,
} from './wrap-hint-engine'

// Task 640 S2b. The pure DOM half of the engine in jsdom (no layout here: the measuring half, the
// near-viewport observer and the frame budget are proven in Chromium, media-src/e2e/wrap-hints.spec.ts).

const HINT = '<span class="vmde-wrap-hint" data-render="1"></span>'

function block(html: string): HTMLElement {
  document.body.innerHTML = `<div class="vditor-reset"><div data-block="0">${html}</div></div>`
  return document.querySelector('[data-block]') as HTMLElement
}

afterEach(() => {
  document.body.replaceChildren()
  window.getSelection()?.removeAllRanges()
})

describe('inlineCodesWithin: which code the engine may hint (Owner decision 2)', () => {
  it('takes inline code of an IR/WYSIWYG surface that is itself a <pre class="vditor-reset">', () => {
    document.body.innerHTML =
      '<pre class="vditor-reset"><div data-block="0"><p><code>a/b</code></p></div></pre>'
    expect(
      inlineCodesWithin(document.querySelector('[data-block]') as HTMLElement),
    ).toHaveLength(1)
  })

  it('takes IR, WYSIWYG and Preview inline code', () => {
    const ir = block(
      '<p><span data-type="code" class="vditor-ir__node"><span class="vditor-ir__marker">`</span><code data-newline="1">a/b</code><span class="vditor-ir__marker">`</span></span></p>',
    )
    expect(inlineCodesWithin(ir)).toHaveLength(1)
    const wysiwyg = block('<p><code data-marker="`">a/b</code></p>')
    expect(inlineCodesWithin(wysiwyg)).toHaveLength(1)
    const preview = block('<p>see <code>a/b</code></p>')
    expect(inlineCodesWithin(preview)).toHaveLength(1)
  })

  it.each([
    ['fenced code', '<pre><code class="language-js">a/b</code></pre>'],
    [
      'a rendered preview',
      '<div class="vditor-ir__preview" data-render="2"><code>a/b</code></div>',
    ],
    ['a data-render widget', '<div data-render="1"><code>a/b</code></div>'],
    [
      'hidden Markdown syntax',
      '<span class="vditor-ir__marker"><code>a/b</code></span>',
    ],
    [
      'a non-editable widget',
      '<span contenteditable="false"><code>a/b</code></span>',
    ],
    [
      'a table cell (Task 640 S2d)',
      '<table><tbody><tr><td><code>a/b</code></td></tr></tbody></table>',
    ],
    [
      'a WYSIWYG preview half',
      '<div class="vditor-wysiwyg__preview"><code>a/b</code></div>',
    ],
  ])('leaves out %s', (_label, html) => {
    expect(inlineCodesWithin(block(html))).toEqual([])
  })
})

describe('rewriteHints', () => {
  const code = (text = 'aaaa/bbbb/cccc'): HTMLElement =>
    block(`<p><code>${text}</code></p>`).querySelector('code') as HTMLElement

  it('inserts hints at text offsets without changing the text', () => {
    const element = code()
    expect(rewriteHints(element, [5, 10])).toBe(true)
    expect(element.innerHTML).toBe(`aaaa/${HINT}bbbb/${HINT}cccc`)
    expect(element.textContent).toBe('aaaa/bbbb/cccc')
    expect(readHintOffsets(element)).toEqual([5, 10])
  })

  it('writes nothing when the code already carries exactly those hints', () => {
    const element = code()
    rewriteHints(element, [5, 10])
    const observer = new MutationObserver(() => undefined)
    observer.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    expect(rewriteHints(element, [10, 5])).toBe(false)
    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
  })

  it('replaces a different plan and clears all hints for an empty plan', () => {
    const element = code()
    rewriteHints(element, [5, 10])
    expect(rewriteHints(element, [10])).toBe(true)
    expect(readHintOffsets(element)).toEqual([10])
    expect(element.childNodes).toHaveLength(3)
    expect(rewriteHints(element, [])).toBe(true)
    expect(element.childNodes).toHaveLength(1)
    expect(element.innerHTML).toBe('aaaa/bbbb/cccc')
  })

  it('puts a hint between two adjacent Text nodes (the split Vditor leaves at a caret marker)', () => {
    const element = code('aaaa/')
    element.append(document.createTextNode('bbbb/cccc'))
    expect(element.childNodes).toHaveLength(2)
    expect(rewriteHints(element, [5, 10])).toBe(true)
    expect(readHintOffsets(element)).toEqual([5, 10])
    expect(element.textContent).toBe('aaaa/bbbb/cccc')
    expect(element.querySelectorAll('.vmde-wrap-hint')).toHaveLength(2)
  })

  it('ignores offsets at the ends or past the text', () => {
    const element = code()
    expect(rewriteHints(element, [0, 14, 99, -3])).toBe(false)
    expect(element.innerHTML).toBe('aaaa/bbbb/cccc')
  })

  it('leaves a code that holds another element alone', () => {
    const element = code('aa/<b>bb</b>/cc')
    expect(rewriteHints(element, [3])).toBe(false)
    expect(element.innerHTML).toBe('aa/<b>bb</b>/cc')
  })

  it('keeps a collapsed caret on its character when hints are inserted around it', () => {
    const element = code()
    window.getSelection()?.collapse(element.firstChild, 7)
    rewriteHints(element, [5, 10])
    const selection = window.getSelection()!
    const probe = document.createRange()
    probe.setStart(element, 0)
    probe.setEnd(selection.anchorNode as Node, selection.anchorOffset)
    expect(probe.toString().length).toBe(7)
  })

  it('is invisible to observers that drop own hint writes, and visible to a real edit', async () => {
    const element = code()
    const observer = new MutationObserver(() => undefined)
    observer.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    rewriteHints(element, [5, 10])
    rewriteHints(element, [10])
    rewriteHints(element, [])
    const records = observer.takeRecords()
    expect(records.length).toBeGreaterThan(0)
    expect(withoutOwnHintRecords(records)).toEqual([])

    rewriteHints(element, [5])
    observer.takeRecords()
    ;(element.lastChild as Text).appendData('!')
    expect(withoutOwnHintRecords(observer.takeRecords())).toHaveLength(1)
    observer.disconnect()
  })
})

describe('installWrapHints without an IntersectionObserver', () => {
  it('is inert: no observer, no write, a callable disposer', () => {
    const surface = block('<p><code>a'.concat('/b'.repeat(80), '</code></p>'))
      .parentElement as HTMLElement
    const dispose = installWrapHints(() => [surface])
    expect(typeof dispose).toBe('function')
    expect(surface.querySelector('.vmde-wrap-hint')).toBeNull()
    dispose()
  })
})
