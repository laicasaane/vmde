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
