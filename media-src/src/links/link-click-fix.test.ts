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

// Task 655 — a bare URL in IR/WYSIWYG is a class-only `span[data-bare-url]` carrying its href; it
// opens through the host under the same modifier policy as a real link.
describe('bare URL span activation (Task 655)', () => {
  const bare = () => {
    document.body.innerHTML =
      '<div class="vditor-ir"><pre contenteditable="true"><p data-block="0">' +
      'See <span class="vmde-bare-url" data-bare-url="1" data-bare-url-href="http://www.example.org">www.example.org</span> now.</p></pre></div>'
    return document.querySelector<HTMLElement>('[data-bare-url="1"]')!
  }

  it('opens the href on Ctrl+click under the modifier policy', () => {
    const post = vi.fn()
    withVscode(post)
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    })
    bare().dispatchEvent(event)
    expect(post).toHaveBeenCalledExactlyOnceWith({
      command: 'open-link',
      href: 'http://www.example.org',
    })
    expect(event.defaultPrevented).toBe(true)
  })

  it('posts nothing on a plain click under the modifier policy', () => {
    const post = vi.fn()
    withVscode(post)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    bare().dispatchEvent(event)
    expect(post).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('opens on a plain click under the click policy', () => {
    const post = vi.fn()
    withVscode(post)
    applyLinkOpenSetting(false)
    bare().dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    expect(post).toHaveBeenCalledExactlyOnceWith({
      command: 'open-link',
      href: 'http://www.example.org',
    })
  })

  it('activates from the caret through Activate Link at Caret', () => {
    const post = vi.fn()
    withVscode(post)
    placeCaretIn(bare())
    expect(activateLinkAtCaret()).toBe(true)
    expect(post).toHaveBeenCalledExactlyOnceWith({
      command: 'open-link',
      href: 'http://www.example.org',
    })
  })
})

// Task 654 — an inline raw HTML anchor is a decorated `span[data-vmde-html-link]` (its tags are
// hidden html-inline markers); the span carries the decoded href and opens through the host.
describe('raw HTML anchor activation (Task 654)', () => {
  const decorated = () => {
    document.body.innerHTML =
      '<div class="vditor-ir"><pre contenteditable="true"><p data-block="0">' +
      'See <span data-type="html-inline" style="display:none"><code>&lt;a href="?a=1&amp;b=2"&gt;</code></span>' +
      '<span class="vmde-html-link" data-vmde-html-link="1" data-vmde-html-link-owner="o:1" data-vmde-html-link-href="?a=1&amp;b=2" role="link">site</span>' +
      '<span data-type="html-inline" style="display:none"><code>&lt;/a&gt;</code></span> end.</p></pre></div>'
    return document.querySelector<HTMLElement>('[data-vmde-html-link="1"]')!
  }

  it('opens the decoded href on Ctrl+click under the modifier policy', () => {
    const post = vi.fn()
    withVscode(post)
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    })
    decorated().dispatchEvent(event)
    expect(post).toHaveBeenCalledExactlyOnceWith({
      command: 'open-link',
      href: '?a=1&b=2',
    })
    expect(event.defaultPrevented).toBe(true)
  })

  it('posts nothing on a plain click under the modifier policy', () => {
    const post = vi.fn()
    withVscode(post)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    decorated().dispatchEvent(event)
    expect(post).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('opens on a plain click under the click policy', () => {
    const post = vi.fn()
    withVscode(post)
    applyLinkOpenSetting(false)
    decorated().dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    expect(post).toHaveBeenCalledExactlyOnceWith({
      command: 'open-link',
      href: '?a=1&b=2',
    })
  })

  it.each([
    ['Preview', '<div class="vditor-preview"><p>#</p></div>'],
    [
      'rendered block',
      '<div class="vditor-ir"><pre data-render="2"><p>#</p></pre></div>',
    ],
    ['no owner', '<div class="vditor-ir"><p>#</p></div>'],
  ])('does not open an authored span (%s)', (name, shell) => {
    const post = vi.fn()
    withVscode(post)
    const authored = `<span data-vmde-html-link="1" ${name === 'no owner' ? '' : 'data-vmde-html-link-owner="o:1" '}data-vmde-html-link-href="command:x">t</span>`
    document.body.innerHTML = shell.replace('#', authored)
    document.querySelector('span')!.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      }),
    )
    expect(post).not.toHaveBeenCalled()
  })

  it('activates the link at the caret inside a revealed body', () => {
    const post = vi.fn()
    withVscode(post)
    document.body.innerHTML =
      '<p>See <span data-type="html-inline"><code>&lt;a href="https://example.com/r"&gt;</code></span>' +
      'site<span data-type="html-inline"><code>&lt;/a&gt;</code></span> end.</p>'
    const body = document.querySelector('p')!.childNodes[2]
    const range = document.createRange()
    range.setStart(body, 2)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    expect(activateLinkAtCaret()).toBe(true)
    expect(post).toHaveBeenCalledExactlyOnceWith({
      command: 'open-link',
      href: 'https://example.com/r',
    })
  })

  it('does not activate from text outside the pair', () => {
    const post = vi.fn()
    withVscode(post)
    document.body.innerHTML =
      '<p>See <span data-type="html-inline"><code>&lt;a href="https://example.com/r"&gt;</code></span>' +
      'site<span data-type="html-inline"><code>&lt;/a&gt;</code></span> end.</p>'
    placeCaretIn(document.querySelector('p')!)
    expect(activateLinkAtCaret()).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })
})
