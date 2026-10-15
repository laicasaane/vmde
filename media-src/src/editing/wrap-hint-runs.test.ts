// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { withoutOwnHintRecords } from '../util/wrap-hint-mark'
import {
  inlineCodesWithin,
  proseParentsWithin,
  readHintOffsets,
  rewriteHints,
  rewriteRun,
  runsOf,
} from './wrap-hint-runs'

// Task 640 S2b/S2c. The layout-free DOM half of the engine in jsdom (no layout here: the measuring
// half, the near-viewport observer and the frame budget are proven in Chromium,
// media-src/e2e/wrap-hints.spec.ts and wrap-hints-words.spec.ts).

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

// Task 640 S2c: which text outside inline code may carry hints (Owner decision 2: hidden Markdown
// syntax, images, inline HTML and rendered widgets are excluded).
describe('proseParentsWithin: where the other words may be hinted', () => {
  const LONG = 'aaaa/bbbb/cccc/dddd'

  it.each([
    ['a paragraph', `<p>${LONG} tail</p>`, 'P'],
    ['a list item', `<ul><li>${LONG} tail</li></ul>`, 'LI'],
    [
      'a heading (IR keeps the # in a marker span)',
      `<h2><span class="vditor-ir__marker vditor-ir__marker--heading">## </span>${LONG}</h2>`,
      'H2',
    ],
    ['bold text', `<p>x <strong>${LONG}</strong></p>`, 'STRONG'],
    ['emphasis', `<p>x <em>${LONG}</em></p>`, 'EM'],
    [
      'IR link text',
      `<p><span data-type="a" class="vditor-ir__node"><span class="vditor-ir__link">${LONG}</span></span></p>`,
      'SPAN',
    ],
    ['WYSIWYG and Preview link text', `<p><a href="x">${LONG}</a></p>`, 'A'],
    ['a quote paragraph', `<blockquote><p>${LONG}</p></blockquote>`, 'P'],
    [
      'the IR callout preview body',
      `<blockquote><div class="vditor-ir__preview vmde-callout__preview" contenteditable="false"><div class="vmde-callout__body"><p>${LONG}</p></div></div></blockquote>`,
      'P',
    ],
    [
      'the callout title',
      `<blockquote><div class="vditor-ir__preview vmde-callout__preview" contenteditable="false"><div class="vmde-callout__title">${LONG}</div></div></blockquote>`,
      'DIV',
    ],
  ])('takes %s', (_label, html, tag) => {
    const parents = proseParentsWithin(block(html))
    expect(parents.map((el) => el.tagName)).toEqual([tag])
  })

  it.each([
    [
      'an IR marker (link URL, heading #, emphasis marks)',
      `<p><span class="vditor-ir__marker vditor-ir__marker--link">${LONG}</span></p>`,
    ],
    [
      'an image and its IR source',
      `<p><span data-type="img" class="vditor-ir__node"><span class="vditor-ir__link">${LONG}</span></span></p>`,
    ],
    ['inline HTML', `<p><span data-type="html-inline">${LONG}</span></p>`],
    ['an HTML entity', `<p><span data-type="html-entity">${LONG}</span></p>`],
    ['inline math', `<p><span data-type="math-inline">${LONG}</span></p>`],
    ['a rendered widget', `<p><span data-render="1">${LONG}</span></p>`],
    [
      'a non-editable node',
      `<p><span contenteditable="false">${LONG}</span></p>`,
    ],
    [
      'a rendered preview half',
      `<div class="vditor-ir__preview"><p>${LONG}</p></div>`,
    ],
    ['fenced code', `<pre><code>${LONG}</code></pre>`],
    ['front matter', `<div data-type="yaml-front-matter"><p>${LONG}</p></div>`],
    ['an HTML block', `<div data-type="html-block"><p>${LONG}</p></div>`],
    [
      'a table cell (Task 640 S2d)',
      `<table><tbody><tr><td>${LONG}</td></tr></tbody></table>`,
    ],
    ['inline code (planned first, on its own)', `<p><code>${LONG}</code></p>`],
    [
      'raw inline HTML elements in Preview',
      `<p><kbd>${LONG}</kbd><sub>${LONG}</sub></p>`,
    ],
    ['text with no block container', LONG],
    ['a short text node', '<p>a/b/c</p>'],
  ])('leaves out %s', (_label, html) => {
    expect(proseParentsWithin(block(html))).toEqual([])
  })

  it('keeps a short Text node that sits beside a hint (the pieces of an already hinted word)', () => {
    const root = block(`<p>${LONG}</p>`)
    const run = runsOf(root.querySelector('p') as Element)[0]
    rewriteRun(run, [5, 10, 15])
    expect(proseParentsWithin(root).map((el) => el.tagName)).toEqual(['P'])
  })
})

describe('runsOf / rewriteRun on a parent with several runs', () => {
  it('reads text on both sides of an element as two runs and rewrites one without touching the other', () => {
    const root = block('<p>aaaa/bbbb/cccc<strong>x</strong>dddd/eeee/ffff</p>')
    const p = root.querySelector('p') as Element
    const [first, second] = runsOf(p)
    expect([first.text, second.text]).toEqual([
      'aaaa/bbbb/cccc',
      'dddd/eeee/ffff',
    ])
    expect(rewriteRun(second, [5, 10])).toBe(true)
    expect(p.innerHTML).toBe(
      `aaaa/bbbb/cccc<strong>x</strong>dddd/${HINT}eeee/${HINT}ffff`,
    )
    // The first run is untouched and still reads as it did; rewriting it leaves the second alone.
    const [again, other] = runsOf(p)
    expect(again.hints).toEqual([])
    expect(other.hints).toEqual([5, 10])
    expect(rewriteRun(again, [5])).toBe(true)
    expect(p.innerHTML).toBe(
      `aaaa/${HINT}bbbb/cccc<strong>x</strong>dddd/${HINT}eeee/${HINT}ffff`,
    )
    expect(rewriteRun(runsOf(p)[1], [])).toBe(true)
    expect(p.innerHTML).toBe(
      `aaaa/${HINT}bbbb/cccc<strong>x</strong>dddd/eeee/ffff`,
    )
    expect(p.textContent).toBe('aaaa/bbbb/cccc' + 'x' + 'dddd/eeee/ffff')
  })
})
