// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activateLinkAtCaret,
  fixLinkClick,
  openLinkUrl,
} from './link-click-fix'
import { applyLinkOpenSetting } from './link-open-policy'

fixLinkClick()

// Task 457 — unit coverage for activateLinkAtCaret's DISPATCH (which link kind opens which way)
// and hrefForLinkLike's URL resolution, the two pieces added on top of caret-link.ts's already
// unit-tested pure `linkLikeInSelection`. Both Ctrl/Cmd+Enter triggers (the webview keydown
// listener AND the `activate-link-at-caret` host message) call this same exported function — see
// its doc comment in link-click-fix.ts — so covering it here covers both.

function withVscode(post: (m: unknown) => void): void {
  ;(globalThis as { vscode?: unknown }).vscode = { postMessage: post }
}

// Place a COLLAPSED caret inside `target`'s first text node (or `target` itself if it has none),
// mirroring what the real Ctrl/Cmd+Enter handler reads via window.getSelection().
function placeCaretIn(target: Node): void {
  const range = document.createRange()
  const node = target.firstChild ?? target
  const offset = node.nodeType === Node.TEXT_NODE ? 1 : 0
  range.setStart(node, offset)
  range.collapse(true)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

afterEach(() => {
  ;(globalThis as { vscode?: unknown }).vscode = undefined
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
  applyLinkOpenSetting(true)
  vi.restoreAllMocks()
})

describe('explicit link Open action', () => {
  it('routes a trimmed external URL through the existing host open-link wire', () => {
    const post = vi.fn()
    withVscode(post)
    expect(openLinkUrl('  https://example.com/a  ')).toBe(true)
    expect(post).toHaveBeenCalledExactlyOnceWith({
      command: 'open-link',
      href: 'https://example.com/a',
    })
  })

  it('declines an empty URL without posting to the host', () => {
    const post = vi.fn()
    withVscode(post)
    expect(openLinkUrl('   ')).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })
})

describe('real IR pointer activation after marker reveal', () => {
  const expandedLink = () => {
    document.body.innerHTML =
      '<div class="vditor-ir"><pre contenteditable="true"><p data-block="0">' +
      '<span data-type="a" class="vditor-ir__node vditor-ir__node--expand">' +
      '<span class="vditor-ir__marker">[</span>' +
      '<span class="vditor-ir__link">Open</span>' +
      '<span class="vditor-ir__marker">](</span>' +
      '<span class="vditor-ir__marker vditor-ir__marker--link">https://example.com/target</span>' +
      '<span class="vditor-ir__marker">)</span></span></p></pre></div>'
    return document.querySelector<HTMLElement>('.vditor-ir__link')!
  }

  it('opens an expanded IR link on Ctrl+click under the modifier policy', () => {
    const post = vi.fn()
    withVscode(post)
    expandedLink().dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      }),
    )
    expect(post).toHaveBeenCalledWith({
      command: 'open-link',
      href: 'https://example.com/target',
    })
  })

  it('opens an expanded IR link on plain click under the click policy', () => {
    const post = vi.fn()
    withVscode(post)
    applyLinkOpenSetting(false)
    expandedLink().dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    expect(post).toHaveBeenCalledWith({
      command: 'open-link',
      href: 'https://example.com/target',
    })
  })
})

describe('activateLinkAtCaret', () => {
  it('returns false and posts nothing when the caret is not inside any link-like element', () => {
    const post = vi.fn()
    withVscode(post)
    document.body.innerHTML = '<p>plain text, no link here</p>'
    placeCaretIn(document.body.querySelector('p')!)
    expect(activateLinkAtCaret()).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })

  it('opens a wiki chip via open-wikilink (same path the click handler uses)', () => {
    const post = vi.fn()
    withVscode(post)
    document.body.innerHTML =
      '<p><span data-wiki-link="1" data-wiki-target="Home">Home</span></p>'
    placeCaretIn(document.body.querySelector('[data-wiki-link]')!)
    expect(activateLinkAtCaret()).toBe(true)
    expect(post).toHaveBeenCalledWith({
      command: 'open-wikilink',
      target: 'Home',
    })
  })

  // Defensive branch: `data-wiki-link="1"` without `data-wiki-target` (a malformed/half-built
  // chip) must not post anything, not throw.
  it('does nothing for a wiki-link element missing data-wiki-target', () => {
    const post = vi.fn()
    withVscode(post)
    document.body.innerHTML = '<p><span data-wiki-link="1">no target</span></p>'
    placeCaretIn(document.body.querySelector('[data-wiki-link]')!)
    expect(activateLinkAtCaret()).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })

  it('opens a code-ref chip via open-code-ref', () => {
    const post = vi.fn()
    withVscode(post)
    document.body.innerHTML =
      '<p><span data-code-ref="1" data-code-ref-path="src/a.ts" data-code-ref-line="3">src/a.ts:3</span></p>'
    placeCaretIn(document.body.querySelector('[data-code-ref]')!)
    expect(activateLinkAtCaret()).toBe(true)
    expect(post).toHaveBeenCalledWith({
      command: 'open-code-ref',
      path: 'src/a.ts',
      line: 3,
    })
  })

  it('opens a real a[href] (WYSIWYG/Preview shape) via open-link', () => {
    const post = vi.fn()
    withVscode(post)
    document.body.innerHTML = '<p><a href="https://example.com/x">x</a></p>'
    placeCaretIn(document.body.querySelector('a')!)
    expect(activateLinkAtCaret()).toBe(true)
    expect(post).toHaveBeenCalledWith({
      command: 'open-link',
      href: 'https://example.com/x',
    })
  })

  // The exact DOM Lute's Md2VditorIRDOM emits for `[a link](https://example.com/path)` (verified
  // via a Lute-in-Node probe, task 457): no real `<a>`, the display text in `.vditor-ir__link`, the
  // raw url as TEXT in a sibling `.vditor-ir__marker--link` — hrefForLinkLike must read THAT, not
  // an attribute.
  it('resolves an IR-mode [text](url) from the sibling marker text, not an attribute', () => {
    const post = vi.fn()
    withVscode(post)
    document.body.innerHTML =
      '<p data-block="0">before ' +
      '<span data-type="a" class="vditor-ir__node">' +
      '<span class="vditor-ir__marker vditor-ir__marker--bracket">[</span>' +
      '<span class="vditor-ir__link">a link</span>' +
      '<span class="vditor-ir__marker vditor-ir__marker--bracket">]</span>' +
      '<span class="vditor-ir__marker vditor-ir__marker--paren">(</span>' +
      '<span class="vditor-ir__marker vditor-ir__marker--link">https://example.com/path</span>' +
      '<span class="vditor-ir__marker vditor-ir__marker--paren">)</span>' +
      '</span> after</p>'
    placeCaretIn(document.body.querySelector('.vditor-ir__link')!)
    expect(activateLinkAtCaret()).toBe(true)
    expect(post).toHaveBeenCalledWith({
      command: 'open-link',
      href: 'https://example.com/path',
    })
  })

  // Same IR shape for a `#fragment` link — routed entirely in-process (tryScrollToSameDocAnchor),
  // never posted to the host, matching the click handler's own same-doc-anchor behaviour (task 243).
  it('routes an IR-mode #fragment link in-process, never posting open-link', () => {
    const post = vi.fn()
    withVscode(post)
    document.body.innerHTML =
      '<p data-block="0">' +
      '<span data-type="a" class="vditor-ir__node">' +
      '<span class="vditor-ir__marker vditor-ir__marker--bracket">[</span>' +
      '<span class="vditor-ir__link">frag</span>' +
      '<span class="vditor-ir__marker vditor-ir__marker--bracket">]</span>' +
      '<span class="vditor-ir__marker vditor-ir__marker--paren">(</span>' +
      '<span class="vditor-ir__marker vditor-ir__marker--link">#heading-id</span>' +
      '<span class="vditor-ir__marker vditor-ir__marker--paren">)</span>' +
      '</span></p>'
    placeCaretIn(document.body.querySelector('.vditor-ir__link')!)
    expect(activateLinkAtCaret()).toBe(true)
    expect(post).not.toHaveBeenCalled()
  })

  // A non-collapsed selection is a text SELECTION, not the caret "sitting inside" a link (mirrors
  // caret-link.test.ts's linkLikeInSelection coverage; asserted here too since this is the entry
  // point the real Ctrl+Enter handler calls).
  it('does nothing for a non-collapsed (dragged) selection across a link', () => {
    const post = vi.fn()
    withVscode(post)
    document.body.innerHTML =
      '<p><span data-wiki-link="1" data-wiki-target="Home">Home</span> tail</p>'
    const chip = document.body.querySelector('[data-wiki-link]')!
    const range = document.createRange()
    range.setStart(chip.firstChild!, 0)
    range.setEnd(document.body.querySelector('p')!.lastChild!, 2)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    expect(activateLinkAtCaret()).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })

  // link-ref style `[ref][1]` is NOT in LINK_LIKE_SELECTOR (its text span carries no
  // `.vditor-ir__link` class — verified in the same probe) — must resolve to nothing, not throw.
  it('ignores a link-ref node (no .vditor-ir__link class, out of scope)', () => {
    const post = vi.fn()
    withVscode(post)
    document.body.innerHTML =
      '<p data-block="0"><span data-type="link-ref" class="vditor-ir__node">' +
      '<span class="vditor-ir__marker vditor-ir__marker--bracket">[</span>' +
      '<span>ref</span>' +
      '<span class="vditor-ir__marker vditor-ir__marker--bracket">]</span>' +
      '<span class="vditor-ir__marker vditor-ir__marker--link">[1]</span>' +
      '</span></p>'
    placeCaretIn(document.body.querySelector('span:not([class])')!)
    expect(activateLinkAtCaret()).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })
})
