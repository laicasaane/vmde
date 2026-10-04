// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCalloutPopoverKeys } from './callout-popover-keys'
import { runCaretGestureHandlers } from '../util/caret-gesture'

/** A minimal WYSIWYG stand-in: a callout blockquote inside the editable `<pre>`, plus the
 *  block-popover panel (a SIBLING of `<pre>`, as it really is in vditor/src/ts/wysiwyg/index.ts)
 *  carrying our appended type `<select>` — the exact shape calloutWysiwygToolbar builds. */
function mountWysiwygCallout(): {
  editor: HTMLElement
  bq: HTMLElement
  bodyText: Text
  select: HTMLSelectElement
} {
  document.body.innerHTML = `
    <div class="vditor-wysiwyg">
      <pre id="ed" contenteditable="true">
        <blockquote data-callout="tip"><p><span class="vmde-callout__marker" contenteditable="false">[!TIP]\n</span>Tip body</p></blockquote>
      </pre>
      <div class="vditor-panel"></div>
    </div>`
  const editor = document.getElementById('ed') as HTMLElement
  const bq = editor.querySelector('blockquote') as HTMLElement
  const bodyText = bq.querySelector('.vmde-callout__marker')
    ?.nextSibling as Text
  const popover = document.querySelector('.vditor-panel') as HTMLElement
  const select = document.createElement('select')
  select.className = 'vditor-input vmde-callout__type'
  popover.appendChild(select)
  ;(window as unknown as Record<string, unknown>).vditor = {
    vditor: {
      currentMode: 'wysiwyg',
      wysiwyg: { element: editor, popover },
    },
  }
  return { editor, bq, bodyText, select }
}

function caretIn(text: Text, offset: number) {
  const range = document.createRange()
  range.setStart(text, offset)
  range.collapse(true)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

function keydown(key: string, opts: KeyboardEventInit = {}) {
  const evt = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  })
  document.dispatchEvent(evt)
  return evt
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
  ;(window as unknown as Record<string, unknown>).vditor = undefined
})
let dispose: (() => void) | null = null
afterEach(() => {
  dispose?.()
  dispose = null
})

// Task 459 UPDATE (2026-07-31, user-decided) — this used to be a dedicated Ctrl/Cmd+Alt+Enter
// listener owned by this module. The user rejected that chord (a third modifier, and Ctrl+Alt
// collides with AltGr on a Polish keyboard layout) in favour of ONE action shared with
// link-click-fix.ts's link activation, dispatched by whatever is under the caret. This module
// REGISTERS with the shared dispatcher (util/caret-gesture.ts) — see caret-gesture.test.ts for the
// dispatcher's own mechanics (registration order, fall-through, collapsed-only) and
// util/caret-gesture-precedence.test.ts for the link-vs-callout precedence case.
// Task 580 CP2-8 — the trigger is `vmde.activateLinkAtCaret` (unbound); Ctrl/Cmd+Enter no longer
// acts in the webview.
describe('installCalloutPopoverKeys — Activate Link at Caret focuses the popover (shared dispatcher)', () => {
  it('focuses the type select when the caret is inside a WYSIWYG callout', () => {
    const { bodyText, select } = mountWysiwygCallout()
    caretIn(bodyText, 2)
    dispose = installCalloutPopoverKeys()
    expect(runCaretGestureHandlers()).toBe(true)
    expect(document.activeElement).toBe(select)
  })

  it('does nothing when the caret is NOT inside a callout', () => {
    document.body.innerHTML = `<div class="vditor-wysiwyg"><pre id="ed" contenteditable="true"><p id="p">plain text</p></pre></div>`
    const p = document.getElementById('p') as HTMLElement
    const text = p.firstChild as Text
    caretIn(text, 2)
    ;(window as unknown as Record<string, unknown>).vditor = {
      vditor: {
        currentMode: 'wysiwyg',
        wysiwyg: { element: document.getElementById('ed') },
      },
    }
    dispose = installCalloutPopoverKeys()
    expect(runCaretGestureHandlers()).toBe(false)
  })

  it.each([
    { ctrlKey: true },
    { metaKey: true },
    { ctrlKey: true, altKey: true },
  ])('a %o Enter keydown no longer focuses the popover', (mods) => {
    const { bodyText, select } = mountWysiwygCallout()
    caretIn(bodyText, 2)
    dispose = installCalloutPopoverKeys()
    const evt = keydown('Enter', mods)
    expect(document.activeElement).not.toBe(select)
    expect(evt.defaultPrevented).toBe(false)
  })

  it('does not stack duplicate registrations across re-inits (install is idempotent)', () => {
    const { bodyText, select } = mountWysiwygCallout()
    caretIn(bodyText, 2)
    const focusSpy = vi.spyOn(select, 'focus')
    dispose = installCalloutPopoverKeys()
    dispose = installCalloutPopoverKeys() // simulate a second re-init without disposing the first
    runCaretGestureHandlers()
    expect(focusSpy).toHaveBeenCalledTimes(1)
  })
})

describe('installCalloutPopoverKeys — Escape returns focus to the editor', () => {
  it('moves focus back to the editor when Escape fires from inside the popover', () => {
    const { editor, select } = mountWysiwygCallout()
    select.focus()
    expect(document.activeElement).toBe(select)
    dispose = installCalloutPopoverKeys()
    const evt = keydown('Escape')
    expect(document.activeElement).toBe(editor)
    expect(evt.defaultPrevented).toBe(true)
  })

  it('does nothing when focus is elsewhere (not inside the popover)', () => {
    mountWysiwygCallout()
    dispose = installCalloutPopoverKeys()
    const evt = keydown('Escape')
    expect(evt.defaultPrevented).toBe(false)
  })
})
