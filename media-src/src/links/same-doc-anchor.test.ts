// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  applySlugifyModeSetting,
  getSlugifyMode,
  tryScrollToSameDocAnchor,
} from './same-doc-anchor'
import { FLASH_CLASS } from '../nav/outline'

// Task 243 L2: tryScrollToSameDocAnchor is the seam link-click-fix.ts and vditor-init.ts's IR
// `link.click` both call BEFORE posting `open-link` to the host — this pins that a same-doc
// `#fragment` is fully handled here (scroll+flash, never posted) while every other href shape
// (classifyHref's external/local/scheme/refused kinds) is left alone for the caller to post.

function fakeVditor(markdown: string, root: HTMLElement) {
  return {
    getValue: () => markdown,
    vditor: { currentMode: 'wysiwyg', wysiwyg: { element: root } },
  } as any
}

function mountHeadings(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

beforeEach(() => {
  applySlugifyModeSetting(undefined) // reset to the default between tests
  // jsdom doesn't implement scrollIntoView — outline.ts's scrollToHeadingIndex calls it
  // unconditionally, so stub it (same workaround used wherever scrollIntoView is exercised
  // under jsdom elsewhere in this suite).
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  document.body.innerHTML = ''
})

// Task 643: a Preview-first open builds no edit view, so getValue() is empty; the held text comes
// from the Preview snapshot hook.
describe('tryScrollToSameDocAnchor without an edit view (task 643)', () => {
  afterEach(() => {
    delete (window as unknown as { __vmdePreviewSnapshot?: unknown })
      .__vmdePreviewSnapshot
  })

  it('resolves a heading slug from the held document text', () => {
    const root = mountHeadings('<h1>The Heading</h1><h2>Other</h2>')
    const vditor = fakeVditor('', root)
    ;(
      window as unknown as { __vmdePreviewSnapshot: () => string }
    ).__vmdePreviewSnapshot = () => '# The Heading\n\n## Other\n'
    expect(tryScrollToSameDocAnchor('#other', vditor)).toBe(true)
    const headings = root.querySelectorAll('h1, h2')
    expect(headings[1].classList.contains(FLASH_CLASS)).toBe(true)
  })
})

describe('tryScrollToSameDocAnchor', () => {
  it('returns false (does not touch the DOM) for a non-anchor href', () => {
    const root = mountHeadings('<h1>The Heading</h1>')
    const vditor = fakeVditor('# The Heading\n', root)
    expect(tryScrollToSameDocAnchor('https://example.com', vditor)).toBe(false)
    expect(tryScrollToSameDocAnchor('sibling.md', vditor)).toBe(false)
    expect(tryScrollToSameDocAnchor('mailto:a@b.com', vditor)).toBe(false)
    expect(root.querySelector('h1')?.classList.contains(FLASH_CLASS)).toBe(
      false,
    )
  })

  it('resolves a plain-text slug and flashes the matching heading', () => {
    const root = mountHeadings('<h1>The Heading</h1><h2>Other</h2>')
    const vditor = fakeVditor('# The Heading\n\n## Other\n', root)
    expect(tryScrollToSameDocAnchor('#the-heading', vditor)).toBe(true)
    const headings = root.querySelectorAll('h1, h2')
    expect(headings[0].classList.contains(FLASH_CLASS)).toBe(true)
    expect(headings[1].classList.contains(FLASH_CLASS)).toBe(false)
  })

  it('resolves a {#custom-id} heading via its custom id, not its text slug', () => {
    const root = mountHeadings('<h1>Plain</h1><h2>Custom Section</h2>')
    const vditor = fakeVditor(
      '# Plain\n\n## Custom Section {#custom-id}\n',
      root,
    )
    expect(tryScrollToSameDocAnchor('#custom-id', vditor)).toBe(true)
    const headings = root.querySelectorAll('h1, h2')
    expect(headings[0].classList.contains(FLASH_CLASS)).toBe(false)
    expect(headings[1].classList.contains(FLASH_CLASS)).toBe(true)
  })

  it('uses a heading before a same-name HTML target, then reveals the target when no heading matches', () => {
    const root = mountHeadings(
      '<h1 data-block="0">Named</h1><p data-block="0">target prose</p>',
    )
    const vditor = fakeVditor(
      '# Named {#custom}\n\n<a name="custom"></a>\n\ntarget prose\n',
      root,
    )
    expect(tryScrollToSameDocAnchor('#custom', vditor)).toBe(true)
    expect(root.querySelector('h1')?.classList.contains(FLASH_CLASS)).toBe(true)

    const anchorRoot = mountHeadings(
      '<p data-block="0"><a name="custom"></a>target prose</p>',
    )
    const noHeading = fakeVditor(
      '<a name="custom"></a>\n\ntarget prose\n',
      anchorRoot,
    )
    expect(tryScrollToSameDocAnchor('#custom', noHeading)).toBe(true)
    expect(anchorRoot.querySelector('p')?.classList.contains(FLASH_CLASS)).toBe(
      true,
    )
  })

  it('flashes the rendered element carrying a matching id for an id target', () => {
    const root = mountHeadings(
      '<p data-block="0">intro</p><p data-block="1"><span id="limits">limits</span> text</p>',
    )
    const vditor = fakeVditor(
      'intro\n\n<span id="limits">limits</span> text\n',
      root,
    )
    expect(tryScrollToSameDocAnchor('#limits', vditor)).toBe(true)
    const blocks = root.querySelectorAll('p')
    expect(blocks[0].classList.contains(FLASH_CLASS)).toBe(false)
    expect(blocks[1].classList.contains(FLASH_CLASS)).toBe(true)
  })

  it('reaches an id target on a non-anchor element in the shown Preview root', () => {
    const edit = mountHeadings('<p data-block="0">edit pane</p>')
    const preview = mountHeadings('<p>one</p><div id="faq"><p>answer</p></div>')
    preview.style.display = 'block'
    const vditor = {
      getValue: () => 'one\n\n<div id="faq"><p>answer</p></div>\n',
      vditor: {
        currentMode: 'wysiwyg',
        wysiwyg: { element: edit },
        preview: { element: preview },
      },
    } as any
    expect(tryScrollToSameDocAnchor('#faq', vditor)).toBe(true)
    expect(preview.querySelector('#faq')?.classList.contains(FLASH_CLASS)).toBe(
      true,
    )
    expect(edit.querySelector('p')?.classList.contains(FLASH_CLASS)).toBe(false)
  })

  it('goes to an id target before a same-name heading and to the heading before an id target', () => {
    const idFirst = mountHeadings(
      '<p data-block="0"><a id="setup"></a>x</p><h1 data-block="1">Setup</h1>',
    )
    const first = fakeVditor('<a id="setup"></a>x\n\n# Setup\n', idFirst)
    expect(tryScrollToSameDocAnchor('#setup', first)).toBe(true)
    expect(idFirst.querySelector('p')?.classList.contains(FLASH_CLASS)).toBe(
      true,
    )
    expect(idFirst.querySelector('h1')?.classList.contains(FLASH_CLASS)).toBe(
      false,
    )

    const headingFirst = mountHeadings(
      '<h1 data-block="0">Setup</h1><p data-block="1"><a id="setup"></a>x</p>',
    )
    const second = fakeVditor('# Setup\n\n<a id="setup"></a>x\n', headingFirst)
    expect(tryScrollToSameDocAnchor('#setup', second)).toBe(true)
    expect(
      headingFirst.querySelector('h1')?.classList.contains(FLASH_CLASS),
    ).toBe(true)
    expect(
      headingFirst.querySelector('p')?.classList.contains(FLASH_CLASS),
    ).toBe(false)
  })

  it('does not match an id outside the visible surface root', () => {
    const root = mountHeadings('<p data-block="0">edit</p>')
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="outside">elsewhere</div>',
    )
    const vditor = fakeVditor('<span id="outside">x</span>\n', root)
    expect(tryScrollToSameDocAnchor('#outside', vditor)).toBe(true)
    expect(
      document.getElementById('outside')?.classList.contains(FLASH_CLASS),
    ).toBe(false)
  })

  it('handles (does not throw/post) an unmatched fragment — nothing flashes', () => {
    const root = mountHeadings('<h1>The Heading</h1>')
    const vditor = fakeVditor('# The Heading\n', root)
    expect(tryScrollToSameDocAnchor('#does-not-exist', vditor)).toBe(true)
    expect(root.querySelector('h1')?.classList.contains(FLASH_CLASS)).toBe(
      false,
    )
  })

  it('percent-decodes the fragment before resolving', () => {
    const root = mountHeadings('<h1>Héllo Wörld</h1>')
    const vditor = fakeVditor('# Héllo Wörld\n', root)
    // encodeURIComponent(slugify('Héllo Wörld')) round-trips through a link generator
    expect(
      tryScrollToSameDocAnchor(`#${encodeURIComponent('héllo-wörld')}`, vditor),
    ).toBe(true)
    expect(root.querySelector('h1')?.classList.contains(FLASH_CLASS)).toBe(true)
  })

  it('is a no-op (still returns true) when there is no live vditor instance yet', () => {
    expect(tryScrollToSameDocAnchor('#anything', undefined)).toBe(true)
  })

  it('applySlugifyModeSetting switches which flavor resolveFragment uses', () => {
    applySlugifyModeSetting('gitlab')
    expect(getSlugifyMode()).toBe('gitlab')
    applySlugifyModeSetting('github')
    expect(getSlugifyMode()).toBe('github')
    // Anything else (unset, a stale/unknown value) falls back to the default.
    applySlugifyModeSetting('bogus')
    expect(getSlugifyMode()).toBe('github')
    applySlugifyModeSetting(undefined)
    expect(getSlugifyMode()).toBe('github')
  })
})
