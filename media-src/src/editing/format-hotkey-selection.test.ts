// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  refusesBlocklessInlineFormat,
  restoreFormatHotkeySelection,
  setupFormatHotkeyGuard,
} from './format-hotkey-guard'

describe('format hotkey selection bridge', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="editor" contenteditable="true">Hello world.</div>'
    const editor = document.getElementById('editor') as HTMLElement
    ;(window as any).vditor = {
      vditor: { currentMode: 'ir', ir: { element: editor } },
    }
  })

  it('restores the exact keydown selection after the host command bridge collapses it', () => {
    const editor = document.getElementById('editor') as HTMLElement
    const text = editor.firstChild as Text
    const selected = document.createRange()
    selected.setStart(text, 6)
    selected.setEnd(text, 11)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(selected)
    setupFormatHotkeyGuard(window)

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'b',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    const collapsed = document.createRange()
    collapsed.setStart(text, 6)
    collapsed.collapse(true)
    selection.removeAllRanges()
    selection.addRange(collapsed)

    expect(restoreFormatHotkeySelection('bold')).toBe(true)
    expect(selection.toString()).toBe('world')
  })
})

describe('blockless IR format refusal (Task 600)', () => {
  let root: HTMLElement

  beforeEach(() => {
    document.body.innerHTML =
      '<pre class="vditor-reset" contenteditable="true"><h1 data-block="0">Probe</h1></pre>'
    root = document.querySelector('pre') as HTMLElement
    ;(window as any).vditor = {
      vditor: { currentMode: 'ir', ir: { element: root } },
    }
    const range = document.createRange()
    range.setStart(root, 0)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })

  it.each([
    'bold',
    'italic',
    'strike',
    'inline-code',
    'list',
    'ordered-list',
    'check',
  ])('refuses %s when an IR selection starts at the editor root', (name) => {
    expect(refusesBlocklessInlineFormat(name)).toBe(true)
  })

  it('refuses a selection in stray root-level text', () => {
    const stray = document.createTextNode('stray')
    root.append(stray)
    getSelection()!.collapse(stray, 2)

    expect(refusesBlocklessInlineFormat('bold')).toBe(true)
  })

  it('refuses a root-starting document selection even when it is not collapsed', () => {
    const range = document.createRange()
    range.setStart(root, 0)
    range.setEnd(root, 1)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    expect(refusesBlocklessInlineFormat('bold')).toBe(true)
  })

  it.each(['bold', 'list'])(
    'allows %s when the selection starts in a heading block',
    (name) => {
      getSelection()!.collapse(root.querySelector('h1')!.firstChild!, 0)

      expect(refusesBlocklessInlineFormat(name)).toBe(false)
    },
  )

  it.each(['code', 'undo'])(
    'leaves unrelated %s actions alone at the root',
    (name) => {
      expect(refusesBlocklessInlineFormat(name)).toBe(false)
    },
  )

  it.each(['wysiwyg', 'sv'])('leaves %s mode alone at the root', (mode) => {
    ;(window as any).vditor.vditor.currentMode = mode

    expect(refusesBlocklessInlineFormat('bold')).toBe(false)
    expect(refusesBlocklessInlineFormat('list')).toBe(false)
  })

  it('leaves a selection outside the IR editor to Vditor', () => {
    const outside = document.createElement('div')
    outside.textContent = 'outside'
    document.body.append(outside)
    getSelection()!.collapse(outside.firstChild!, 0)

    expect(refusesBlocklessInlineFormat('bold')).toBe(false)
  })

  it('leaves a missing selection unchanged', () => {
    getSelection()!.removeAllRanges()

    expect(refusesBlocklessInlineFormat('bold')).toBe(false)
  })
})
