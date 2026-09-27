// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CARET_INSIDE_CLASS,
  applyCaretInside,
  linkLikeAt,
  linkLikeInSelection,
} from './caret-link'

// Task 457. The point of splitting these out of the DOM wiring is that the interesting cases are
// all "which element does the caret resolve to", which needs no editor, no Vditor and no webview.

function html(markup: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = markup
  return root
}

describe('linkLikeAt', () => {
  it('resolves from a text node inside a wiki chip (the normal caret case)', () => {
    const root = html(
      '<p>before <span data-wiki-link="1">Page A</span> after</p>',
    )
    const chip = root.querySelector('[data-wiki-link="1"]')!
    expect(linkLikeAt(chip.firstChild)).toBe(chip)
  })

  it('resolves when handed the element itself, not just a text node', () => {
    const root = html('<p><span data-wiki-link="1">Page A</span></p>')
    const chip = root.querySelector('[data-wiki-link="1"]')!
    expect(linkLikeAt(chip)).toBe(chip)
  })

  it('returns null for prose outside any link', () => {
    const root = html('<p>just text <span data-wiki-link="1">Page A</span></p>')
    expect(linkLikeAt(root.querySelector('p')!.firstChild)).toBeNull()
  })

  it('returns null for a null node rather than throwing', () => {
    expect(linkLikeAt(null)).toBeNull()
  })

  // The decision was "everything link-like", not "wiki chips" — plain markdown links are the MORE
  // common case, so covering only chips would leave the bigger half of the same gap open.
  it.each([
    ['plain anchor', '<a href="./other.md">text</a>', 'a[href]'],
    [
      'code reference',
      '<span data-code-ref="1">src/a.ts:1</span>',
      '[data-code-ref="1"]',
    ],
    [
      'IR link marker',
      '<span class="vditor-ir__link">text</span>',
      '.vditor-ir__link',
    ],
  ])('resolves a %s', (_label, markup, sel) => {
    const root = html(`<p>x ${markup} y</p>`)
    const el = root.querySelector(sel)!
    expect(linkLikeAt(el.firstChild)).toBe(el)
  })

  it('does not treat an anchor without href as a link', () => {
    const root = html('<p><a>no href</a></p>')
    expect(linkLikeAt(root.querySelector('a')!.firstChild)).toBeNull()
  })

  it('resolves the INNERMOST link when one is nested inside another', () => {
    const root = html('<a href="#o"><span data-wiki-link="1">inner</span></a>')
    const chip = root.querySelector('[data-wiki-link="1"]')!
    expect(linkLikeAt(chip.firstChild)).toBe(chip)
  })
})

describe('linkLikeInSelection', () => {
  it('resolves a collapsed caret inside a chip', () => {
    const root = html('<p><span data-wiki-link="1">Page A</span></p>')
    const chip = root.querySelector('[data-wiki-link="1"]')!
    expect(
      linkLikeInSelection({ anchorNode: chip.firstChild, isCollapsed: true }),
    ).toBe(chip)
  })

  // Dragging a selection across a link is not targeting it — the user is selecting text, and
  // activating there would fight ordinary editing.
  it('ignores a NON-collapsed selection even when it starts inside a chip', () => {
    const root = html('<p><span data-wiki-link="1">Page A</span></p>')
    const chip = root.querySelector('[data-wiki-link="1"]')!
    expect(
      linkLikeInSelection({ anchorNode: chip.firstChild, isCollapsed: false }),
    ).toBeNull()
  })

  it('returns null when there is no selection at all', () => {
    expect(linkLikeInSelection(null)).toBeNull()
  })
})

describe('applyCaretInside', () => {
  let root: HTMLElement
  let a: HTMLElement
  let b: HTMLElement

  beforeEach(() => {
    root = html(
      '<p><span data-wiki-link="1" id="a">A</span><span data-wiki-link="1" id="b">B</span></p>',
    )
    a = root.querySelector('#a')!
    b = root.querySelector('#b')!
  })

  it('marks the target and reports a change', () => {
    expect(applyCaretInside(root, a)).toBe(true)
    expect(a.classList.contains(CARET_INSIDE_CLASS)).toBe(true)
  })

  // Idempotence is load-bearing: selectionchange fires on every caret move, so a non-idempotent
  // apply would churn the DOM on every keystroke inside a link.
  it('is idempotent — re-applying the same target reports no change', () => {
    a.classList.add('wiki-link-chip')
    applyCaretInside(root, a)
    const watcher = new MutationObserver(() => undefined)
    watcher.observe(root, { subtree: true, attributes: true })
    try {
      expect(applyCaretInside(root, a)).toBe(false)
      expect(watcher.takeRecords()).toEqual([])
      applyCaretInside(root, null)
      expect(a.className).toBe('wiki-link-chip')
    } finally {
      watcher.disconnect()
    }
  })

  it('moves the mark off the previous link when the caret moves to another', () => {
    applyCaretInside(root, a)
    expect(applyCaretInside(root, b)).toBe(true)
    expect(a.classList.contains(CARET_INSIDE_CLASS)).toBe(false)
    expect(b.classList.contains(CARET_INSIDE_CLASS)).toBe(true)
  })

  it('clears the mark when the caret leaves every link', () => {
    applyCaretInside(root, a)
    expect(applyCaretInside(root, null)).toBe(true)
    expect(root.querySelectorAll(`.${CARET_INSIDE_CLASS}`)).toHaveLength(0)
  })

  it('reports no change when clearing an already-clean tree', () => {
    expect(applyCaretInside(root, null)).toBe(false)
  })

  it('tolerates a null root rather than throwing', () => {
    expect(applyCaretInside(null, a)).toBe(false)
  })
})
