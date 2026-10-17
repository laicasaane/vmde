// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { InnerVditor } from '../util/inner-vditor'
import { installSectionIndent, setSectionIndentEnabled } from './section-indent'

// Task 649: the controller marks top-level blocks of the live surfaces and nothing else.
function surface(html: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'vditor-reset'
  el.innerHTML = html
  document.body.append(el)
  return el
}
const block = (tag: string, text: string, extra = '') =>
  `<${tag} data-block="0"${extra}>${text}</${tag}>`
const depths = (el: HTMLElement) =>
  [...el.children].map((c) => c.getAttribute('data-vmde-indent'))
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

afterEach(() => {
  document.body.innerHTML = ''
})

describe('section indent controller (task 649)', () => {
  const doc = () =>
    block('p', 'intro') +
    block('h1', 'a') +
    block('p', 'a1') +
    block('h2', 'b') +
    block('p', 'b1') +
    block('h3', 'c') +
    block('div', 'refs', ' data-type="link-ref-defs-block"')

  it('off: installs no marks and no root marker', () => {
    const ir = surface(doc())
    const c = installSectionIndent(
      { ir: { element: ir } } as InnerVditor,
      false,
    )
    expect(depths(ir).every((d) => d === null)).toBe(true)
    expect(ir.hasAttribute('data-vmde-indent-root')).toBe(false)
    c.dispose()
  })

  it('on: depth = heading level - 1, tail block stays 0; off again removes every mark once', () => {
    const ir = surface(doc())
    const c = installSectionIndent({ ir: { element: ir } } as InnerVditor, true)
    expect(depths(ir)).toEqual([null, null, null, '1', '1', '2', null])
    expect(ir.hasAttribute('data-vmde-indent-root')).toBe(true)
    c.setEnabled(false)
    expect(depths(ir).every((d) => d === null)).toBe(true)
    expect(ir.hasAttribute('data-vmde-indent-root')).toBe(false)
    c.dispose()
  })

  it('a live toggle through setSectionIndentEnabled reaches the installed controller', () => {
    const ir = surface(doc())
    const c = installSectionIndent(
      { ir: { element: ir } } as InnerVditor,
      false,
    )
    setSectionIndentEnabled(true)
    expect(depths(ir)[3]).toBe('1')
    c.dispose()
    setSectionIndentEnabled(false) // no controller left: a no-op
    expect(depths(ir)[3]).toBe('1')
  })

  it('a changed heading level re-marks the blocks up to the next heading', async () => {
    const ir = surface(doc())
    const c = installSectionIndent({ ir: { element: ir } } as InnerVditor, true)
    const h2 = ir.children[3]
    const h4 = document.createElement('h4')
    h4.setAttribute('data-block', '0')
    h4.textContent = 'b'
    h2.replaceWith(h4)
    await flush()
    expect(depths(ir)).toEqual([null, null, null, '3', '3', '2', null])
    c.dispose()
  })

  it('Preview: full pass per re-render, footnote list at depth 0', async () => {
    const preview = document.createElement('div')
    document.body.append(preview)
    const c = installSectionIndent(
      { preview: { previewElement: preview } } as InnerVditor,
      true,
    )
    preview.innerHTML =
      '<h2>x</h2><p>y</p><div class="footnotes-defs-div"><ol></ol></div>'
    await flush()
    expect(depths(preview)).toEqual(['1', '1', null])
    c.dispose()
  })

  it('headings between a paired details opening and closing block start no section', () => {
    const html = (src: string) =>
      `<div data-block="0" data-type="html-block"><pre><code>${src}</code></pre></div>`
    const ir = surface(
      block('h2', 'a') +
        html('&lt;details&gt;') +
        block('h4', 'inner') +
        html('&lt;/details&gt;') +
        block('p', 'after'),
    )
    const c = installSectionIndent({ ir: { element: ir } } as InnerVditor, true)
    expect(depths(ir)).toEqual(['1', '1', '1', '1', '1'])
    c.dispose()
  })
})
