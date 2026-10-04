// @vitest-environment jsdom

// Tasks 457/459 — registration-order precedence, exercised through the REAL registrants (not
// synthetic match/handle stubs like caret-gesture.test.ts uses). A wiki chip nested inside a
// callout blockquote makes BOTH links/link-click-fix.ts's `linkLikeAt` and
// editing/callout-popover-keys.ts's `calloutBlockquoteAt` resolve to something non-null for the
// SAME caret position — see caret-gesture.ts's module header for why link-before-callout is the
// intended precedence (activate the more specific/inner target), not an accident of import order.
// This test proves the two real modules, wired together the way boot/main.ts + finish-init.ts
// actually order them (link registers first), keep that precedence.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installCalloutPopoverKeys } from '../editing/callout-popover-keys'
import { fixLinkClick } from '../links/link-click-fix'
import { runCaretGestureHandlers } from './caret-gesture'

function withVscode(post: (m: unknown) => void): void {
  ;(globalThis as { vscode?: unknown }).vscode = { postMessage: post }
}

function caretIn(text: Text, offset: number) {
  const range = document.createRange()
  range.setStart(text, offset)
  range.collapse(true)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

afterEach(() => {
  ;(globalThis as { vscode?: unknown }).vscode = undefined
  ;(window as unknown as Record<string, unknown>).vditor = undefined
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

describe('caret-gesture registration order: link wins over its containing callout', () => {
  it('Activate Link at Caret on a wiki chip inside a [!TIP] callout activates the LINK, not the popover', () => {
    document.body.innerHTML = `
      <div class="vditor-wysiwyg">
        <pre id="ed" contenteditable="true">
          <blockquote data-callout="tip">
            <p><span class="vmde-callout__marker" contenteditable="false">[!TIP]\n</span>See
              <span data-wiki-link="1" data-wiki-target="Home">Home</span> for details.</p>
          </blockquote>
        </pre>
        <div class="vditor-panel"></div>
      </div>`
    const chip = document.querySelector('[data-wiki-link]') as HTMLElement
    const popover = document.querySelector('.vditor-panel') as HTMLElement
    const select = document.createElement('select')
    select.className = 'vditor-input vmde-callout__type'
    popover.appendChild(select)
    ;(window as unknown as Record<string, unknown>).vditor = {
      vditor: {
        currentMode: 'wysiwyg',
        wysiwyg: {
          element: document.getElementById('ed'),
          popover,
        },
      },
    }

    const post = vi.fn()
    withVscode(post)
    // boot/main.ts registers link-click-fix's gesture at module scope (first); finish-init.ts
    // registers callout-popover-keys' per re-init (second) — same order here.
    fixLinkClick()
    const disposeCallout = installCalloutPopoverKeys()

    caretIn(chip.firstChild as Text, 1)
    // Task 580 CP2-8 — `vmde.activateLinkAtCaret`'s message runs this dispatch.
    const activated = runCaretGestureHandlers()

    expect(post).toHaveBeenCalledWith({
      command: 'open-wikilink',
      target: 'Home',
    })
    expect(document.activeElement).not.toBe(select)
    expect(activated).toBe(true)

    disposeCallout()
  })
})
