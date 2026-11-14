// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { wrapLiveLineBreakIdentity } from './live-line-breaks'

function fakeLute(
  renderedHtml = '<p data-block="0">soft alpha\nsoft beta</p>' +
    '<p data-block="0">two-space alpha<br />two-space beta</p>' +
    '<p data-block="0">backslash alpha<br />backslash beta</p>',
) {
  const render = vi.fn((_markdown: string) => renderedHtml)
  const serialize = vi.fn((html: string) => {
    const root = document.createElement('div')
    root.innerHTML = html
    return (
      Array.from(root.children, (child) => child.textContent).join('\n\n') +
      '\n'
    )
  })
  const spin = vi.fn((html: string) => html)
  const spinSv = vi.fn((markdown: string) =>
    markdown
      .split('\n')
      .map(
        (line) =>
          `<span data-type="text">${line.replace(/ {2,}$|\\$/u, '')}</span>` +
          '<span data-type="newline"><br><span style="display:none">\n</span></span>',
      )
      .join(''),
  )
  return {
    lute: {
      Md2VditorIRDOM: render,
      Md2VditorDOM: render,
      VditorIRDOM2Md: serialize,
      VditorDOM2Md: serialize,
      SpinVditorIRDOM: spin,
      SpinVditorDOM: spin,
      SpinVditorSVDOM: spinSv,
    },
    render,
    serialize,
    spin,
  }
}

const markdown = [
  'soft alpha',
  'soft beta',
  '',
  'two-space alpha  ',
  'two-space beta',
  '',
  'backslash alpha\\',
  'backslash beta',
].join('\n')

describe('wrapLiveLineBreakIdentity', () => {
  it('keeps soft source bytes in text nodes while retaining exact hard-break identity', () => {
    const { lute } = fakeLute()
    wrapLiveLineBreakIdentity(lute)

    const dom = lute.Md2VditorIRDOM(markdown)
    expect(dom).toContain('soft alpha\nsoft beta')
    expect(dom).not.toContain('data-vmde-soft-break')
    expect(dom.match(/data-vmde-hard-break=/gu)).toHaveLength(2)
    expect(lute.VditorIRDOM2Md(dom)).toBe(`${markdown}\n`)
  })

  it('leaves every prose and verbatim container byte-identical for CSS reflow', () => {
    const rendered =
      '<p>Evidence: <span data-type="a"><span class="vditor-ir__link">label</span></span>\nand section</p>' +
      '<p><strong>strong alpha\nstrong beta</strong></p>' +
      '<ul><li>list alpha\nlist beta</li></ul>' +
      '<blockquote><p>quote alpha\nquote beta</p></blockquote>' +
      '<pre data-type="code-block"><code>code alpha\ncode beta</code></pre>'
    const { lute } = fakeLute(rendered)
    wrapLiveLineBreakIdentity(lute)

    const dom = lute.Md2VditorIRDOM('no explicit hard breaks')

    expect(dom).toBe(rendered)
    expect(dom).not.toContain('data-vmde-soft-break')
    expect(dom).toContain('code alpha\ncode beta')
  })

  it('leaves soft breaks raw and marks exact hard breaks in IR and WYSIWYG', () => {
    const { lute } = fakeLute()
    wrapLiveLineBreakIdentity(lute)

    for (const render of [lute.Md2VditorIRDOM, lute.Md2VditorDOM]) {
      const dom = render(markdown)
      expect(dom).toContain('soft alpha\nsoft beta')
      expect(dom).not.toContain('data-vmde-soft-break')
      expect(dom).toContain('data-vmde-hard-break="%20%20"')
      expect(dom).toContain('data-vmde-hard-break="%5C"')
    }
  })

  it('restores byte-exact Markdown through both serializers', () => {
    const { lute } = fakeLute()
    wrapLiveLineBreakIdentity(lute)
    const ir = lute.Md2VditorIRDOM(markdown)
    const wysiwyg = lute.Md2VditorDOM(markdown)

    expect(lute.VditorIRDOM2Md(ir)).toBe(`${markdown}\n`)
    expect(lute.VditorDOM2Md(wysiwyg)).toBe(`${markdown}\n`)
  })

  it('keeps raw soft breaks and hard-break identity through both spin methods', () => {
    const { lute } = fakeLute()
    wrapLiveLineBreakIdentity(lute)

    for (const [render, spin] of [
      [lute.Md2VditorIRDOM, lute.SpinVditorIRDOM],
      [lute.Md2VditorDOM, lute.SpinVditorDOM],
    ] as const) {
      const spun = spin(render(markdown))
      expect(spun).toContain('soft alpha\nsoft beta')
      expect(spun).not.toContain('data-vmde-soft-break')
      expect(spun.match(/data-vmde-hard-break=/gu)).toHaveLength(2)
    }
  })

  it('restores exact hard-break suffixes in SV source DOM', () => {
    const { lute } = fakeLute()
    wrapLiveLineBreakIdentity(lute)

    const root = document.createElement('div')
    root.innerHTML = lute.SpinVditorSVDOM(markdown)
    expect(root.textContent).toBe(`${markdown}\n`)
  })

  it('is idempotent when installers race on the same Lute instance', () => {
    const { lute, render } = fakeLute()
    wrapLiveLineBreakIdentity(lute)
    wrapLiveLineBreakIdentity(lute)

    lute.Md2VditorIRDOM(markdown)
    expect(render).toHaveBeenCalledTimes(1)
  })
})

// Task 733 / 009: the identity encoder parses its input once and reads the parsed root's HTML once
// (the output). It never re-serializes the root per hard break, and every break of one call still
// gets its own marker.
describe('encodeIdentityDom cost (Task 733 / 009)', () => {
  const MARKER = /\uE301VMDE_HARD_BREAK_(\d+)\uE30F/gu
  const breaks = (count: number) =>
    `<p data-block="0">${Array.from({ length: count }, (_, i) => `line ${i}<br data-vmde-hard-break="%20%20">`).join('')}tail</p>`

  it('reads innerHTML once for 50 hard breaks and gives each break a distinct marker', () => {
    const { lute, spin } = fakeLute()
    wrapLiveLineBreakIdentity(lute)
    const html = breaks(50)
    const read = vi.spyOn(Element.prototype, 'innerHTML', 'get')
    let output: string
    let reads: number
    try {
      output = lute.SpinVditorIRDOM(html)
      reads = read.mock.calls.length
    } finally {
      read.mockRestore()
    }
    expect(reads).toBe(1)
    const encoded = spin.mock.calls[0][0]
    const markers = Array.from(encoded.matchAll(MARKER), (m) => m[1])
    expect(markers).toHaveLength(50)
    expect(new Set(markers).size).toBe(50)
    expect(output).toBe(html)
  })

  it('keeps markers unique when the input already holds marker text', () => {
    const { lute, spin } = fakeLute()
    wrapLiveLineBreakIdentity(lute)
    const html =
      '<p data-block="0">\uE301VMDE_HARD_BREAK_0\uE30F a<br data-vmde-hard-break="%20%20">b<br data-vmde-hard-break="%5C">c</p>'
    const output = lute.SpinVditorIRDOM(html)
    const encoded = spin.mock.calls[0][0]
    const markers = Array.from(encoded.matchAll(MARKER), (m) => m[1])
    expect(markers).toHaveLength(3)
    expect(new Set(markers).size).toBe(3)
    expect(output).toBe(html)
  })

  it('keeps markers unique when a character reference spells a later marker character', () => {
    const { lute, spin } = fakeLute()
    wrapLiveLineBreakIdentity(lute)
    // The parsed text holds the marker `\uE301VMDE_HARD_BREAK_0\uE30F`, its "V" written as a reference.
    const html =
      '<p data-block="0">\uE301&#x56;MDE_HARD_BREAK_0\uE30F a<br data-vmde-hard-break="%20%20">b<br data-vmde-hard-break="%5C">c</p>'
    lute.SpinVditorIRDOM(html)
    const encoded = spin.mock.calls[0][0]
    const markers = Array.from(encoded.matchAll(MARKER), (m) => m[1])
    expect(markers).toHaveLength(3)
    expect(new Set(markers).size).toBe(3)
  })

  it('keeps markers unique when a reference spells the first marker character', () => {
    const { lute, spin } = fakeLute()
    wrapLiveLineBreakIdentity(lute)
    for (const start of ['&#xE301;', '&#XE301', '&#58113;', '&#x0e301;']) {
      spin.mockClear()
      lute.SpinVditorIRDOM(
        `<p data-block="0">${start}VMDE_HARD_BREAK_0\uE30F a<br data-vmde-hard-break="%20%20">b</p>`,
      )
      const encoded = spin.mock.calls[0][0]
      const markers = Array.from(encoded.matchAll(MARKER), (m) => m[1])
      expect(new Set(markers).size, start).toBe(2)
    }
  })

  it('restores the Markdown suffix of every one of 50 hard breaks', () => {
    const { lute } = fakeLute()
    wrapLiveLineBreakIdentity(lute)
    const markdown = lute.VditorIRDOM2Md(breaks(50))
    expect(markdown.match(/ {2}\n/gu)).toHaveLength(50)
    expect(markdown).toContain('line 49  \ntail')
  })
})
