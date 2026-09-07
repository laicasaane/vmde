// @vitest-environment jsdom
// Task 456 round 9 — unit cover for the two DOM behaviours the pure state machine (escape-arm.ts)
// cannot express, and that the real-VS-Code spec proves end-to-end but slowly:
//   1. the focus RETRY (bug 2): a `.focus()` that silently does not take is re-attempted on the
//      next frames until it does, which is the whole fix — a one-shot call was 0/26 in real VS Code.
//   2. the caret CAPTURE (bug 1's remaining half): the position the caret held BEFORE the gesture is
//      what comes back on the return, not the document start.
// jsdom's focus() always works, so case 1 is driven by stubbing focus() to no-op for N attempts —
// the same shape as the measured webview behaviour, without needing a webview.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installEditorCaretTracking } from './editor-caret'
import {
  consumeToolbarSelectionOrigin,
  installEscapeToolbar,
  peekConsumedToolbarSelectionOrigin,
} from './escape-toolbar'

let dispose: (() => void) | null = null

function mount(): { editor: HTMLElement; buttons: HTMLElement[] } {
  document.body.innerHTML = `
    <div class="vditor">
      <div class="vditor-toolbar">
        <div class="vditor-toolbar__item"><button data-type="emoji"></button></div>
        <div class="vditor-toolbar__item"><button data-type="bold"></button></div>
      </div>
      <div class="vditor-ir"><pre id="ed" contenteditable="true"><p>hello world</p></pre></div>
    </div>`
  const editor = document.getElementById('ed') as HTMLElement
  const toolbar = document.querySelector('.vditor-toolbar') as HTMLElement
  ;(window as unknown as Record<string, unknown>).vditor = {
    vditor: {
      currentMode: 'ir',
      ir: { element: editor },
      toolbar: { element: toolbar },
    },
  }
  const buttons = Array.from(
    toolbar.querySelectorAll('button'),
  ) as HTMLElement[]
  return { editor, buttons }
}

/** Collapsed caret at `offset` in the first text node under `el`. */
function caretIn(el: HTMLElement, offset: number): void {
  const text = document
    .createTreeWalker(el, NodeFilter.SHOW_TEXT)
    .nextNode() as Text
  const range = document.createRange()
  range.setStart(text, offset)
  range.collapse(true)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

function selectText(el: HTMLElement, anchor: number, focus: number): void {
  const text = document
    .createTreeWalker(el, NodeFilter.SHOW_TEXT)
    .nextNode() as Text
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.setBaseAndExtent(text, anchor, text, focus)
  document.dispatchEvent(new Event('selectionchange'))
}

const key = (k: string) =>
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
  )

/** Run `n` animation frames. jsdom implements rAF as a timer, so fake timers drive it. */
async function frames(n: number) {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(20)
  }
}

// jsdom's hasFocus() defaults to false and the retry loop now stops when the document has lost
// focus (a webview the user left is not one to fight for), so it is stubbed true file-wide.
const originalHasFocus = document.hasFocus
beforeEach(() => {
  document.hasFocus = () => true
  vi.useFakeTimers()
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})
afterEach(() => {
  document.hasFocus = originalHasFocus
  dispose?.()
  dispose = null
  vi.useRealTimers()
})

describe('escape-toolbar focus retry (task 456 bug 2)', () => {
  it('keeps re-attempting until the focus actually lands', async () => {
    const { editor, buttons } = mount()
    caretIn(editor, 3)
    dispose = installEscapeToolbar()

    // Reproduce the measured webview behaviour: focus() is a no-op for the first few attempts.
    const real = buttons[0].focus.bind(buttons[0])
    let refusals = 3
    buttons[0].focus = ((opts?: FocusOptions) => {
      if (refusals-- > 0) return
      real(opts)
    }) as HTMLElement['focus']

    key('Escape')
    key('Tab')
    expect(
      document.activeElement,
      'the first attempt was refused, exactly as the real webview does',
    ).not.toBe(buttons[0])

    await frames(5)
    expect(document.activeElement, 'a later frame got it there').toBe(
      buttons[0],
    )
  })

  it('stops retrying once a real gesture intervenes', async () => {
    const { editor, buttons } = mount()
    caretIn(editor, 3)
    dispose = installEscapeToolbar()
    buttons[0].focus = (() => {
      /* never lands, so the retry loop stays alive */
    }) as HTMLElement['focus']

    key('Escape')
    key('Tab')
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    // Restore a working focus() AFTER the cancel: if the loop were still armed it would now land.
    buttons[0].focus = HTMLElement.prototype.focus.bind(buttons[0])

    await frames(5)
    expect(
      document.activeElement,
      'the click cancelled the pending retry rather than yanking focus away later',
    ).not.toBe(buttons[0])
  })
})

describe('escape-toolbar caret return (task 456 bug 1)', () => {
  it('puts the caret back where it was, not at the document start', async () => {
    const { editor, buttons } = mount()
    // The shared tracker is live, exactly as in production — and it is the thing that goes WRONG
    // here, so the test has to model that rather than leave it empty: without the tracker seeded
    // with the bogus position, this case would fail for want of ANY range instead of for the range
    // being in the wrong place.
    installEditorCaretTracking()
    caretIn(editor, 6) // mid-word, so "document start" is unmistakably different
    document.dispatchEvent(new Event('selectionchange'))
    dispose = installEscapeToolbar()

    key('Escape')
    key('Tab')
    await frames(2)
    expect(document.activeElement).toBe(buttons[0])
    // What a real browser does when focus moves to a <button>: the Selection collapses into the
    // editor's FIRST text node. jsdom does not, so reproduce it — and let the tracker record it,
    // which is precisely how the good position used to be lost (task 456 round 9).
    caretIn(editor, 0)
    document.dispatchEvent(new Event('selectionchange'))
    window.getSelection()?.removeAllRanges()

    key('Escape')
    await frames(2)
    const sel = window.getSelection()!
    expect(sel.rangeCount, 'a caret came back at all').toBe(1)
    expect(sel.getRangeAt(0).startOffset, 'and at the pre-gesture offset').toBe(
      6,
    )
    expect(editor.contains(sel.anchorNode), 'inside the editor').toBe(true)
  })
})

describe('escape-toolbar keyboard selection origin (task 553)', () => {
  it('exposes only the pre-widening backward range after consumed Tab', () => {
    const { editor } = mount()
    dispose = installEscapeToolbar()
    selectText(editor, 8, 6)

    key('Escape')
    expect(peekConsumedToolbarSelectionOrigin()).toBeNull()
    selectText(editor, 11, 0)
    key('Tab')

    const origin = peekConsumedToolbarSelectionOrigin()
    expect(origin?.range.toString()).toBe('wo')
    expect(origin?.backward).toBe(true)
    expect(consumeToolbarSelectionOrigin()).toBe(true)
    expect(peekConsumedToolbarSelectionOrigin()).toBeNull()
  })

  it('fails closed when an origin leaf changes and replaces a consumed session', () => {
    const { editor } = mount()
    dispose = installEscapeToolbar()
    selectText(editor, 6, 8)
    key('Escape')
    key('Tab')
    const text = document
      .createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      .nextNode() as Text
    text.data = 'hello changed'
    expect(peekConsumedToolbarSelectionOrigin()).toBeNull()
    expect(consumeToolbarSelectionOrigin()).toBe(true)

    editor.focus()
    selectText(editor, 0, 5)
    key('Escape')
    key('Tab')
    expect(peekConsumedToolbarSelectionOrigin()?.range.toString()).toBe('hello')
  })
})
