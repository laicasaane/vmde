// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  discardCommandSelection,
  refusesBlocklessInlineFormat,
  restoreCommandSelection,
  setupFormatHotkeyGuard,
} from './format-hotkey-guard'

// Task 580 policy 7 — the command selection snapshot. jsdom events are never trusted, so these
// tests drive the guard's window listeners with plain trusted-shaped event objects.
describe('command selection snapshot', () => {
  let editor: HTMLElement
  let text: Text
  let dispose: () => void
  const listeners = new Map<string, (event: any) => void>()

  function fire(type: string, init: Record<string, unknown> = {}) {
    listeners.get(type)?.({
      type,
      key: 'Control',
      keyCode: 17,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      isTrusted: true,
      target: editor,
      preventDefault: vi.fn(),
      ...init,
    })
  }

  const chord = (init: Record<string, unknown> = {}) =>
    fire('keydown', { key: 'b', keyCode: 66, ctrlKey: true, ...init })

  function select(
    anchor: Node,
    anchorOffset: number,
    focus: Node,
    focusOffset: number,
  ) {
    getSelection()!.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
  }

  function collapseTo(node: Node, offset: number) {
    getSelection()!.collapse(node, offset)
  }

  beforeEach(() => {
    document.body.innerHTML =
      '<div id="editor" contenteditable="true"><p data-block="0">Hello world.</p></div><button id="outside">x</button>'
    editor = document.getElementById('editor') as HTMLElement
    text = editor.querySelector('p')!.firstChild as Text
    ;(window as any).vditor = {
      vditor: { currentMode: 'ir', ir: { element: editor } },
    }
    listeners.clear()
    const win = {
      navigator: { platform: 'Linux x86_64' },
      document,
      getSelection: () => document.getSelection(),
      get vditor() {
        return (window as any).vditor
      },
      addEventListener: (type: string, fn: any) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    }
    dispose = setupFormatHotkeyGuard(
      win as unknown as Window & typeof globalThis,
    )
  })

  afterEach(() => {
    dispose()
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('restores the keydown selection after the command bridge collapses it', () => {
    select(text, 6, text, 11)
    chord()
    collapseTo(text, 6)

    expect(restoreCommandSelection()).toBe(true)
    expect(getSelection()!.toString()).toBe('world')
    expect(document.activeElement).toBe(editor)
  })

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Meta', { metaKey: true }],
    ['Alt', { altKey: true }],
  ])('takes the snapshot for any %s chord, bound or not', (_name, mods) => {
    select(text, 6, text, 11)
    fire('keydown', { key: 'q', keyCode: 81, ...mods })
    collapseTo(text, 0)

    expect(restoreCommandSelection()).toBe(true)
    expect(getSelection()!.toString()).toBe('world')
  })

  it('preserves a backward selection', () => {
    select(text, 11, text, 6)
    chord()
    collapseTo(text, 6)

    expect(restoreCommandSelection()).toBe(true)
    const selection = getSelection()!
    expect(selection.toString()).toBe('world')
    expect([selection.anchorNode, selection.anchorOffset]).toEqual([text, 11])
    expect([selection.focusNode, selection.focusOffset]).toEqual([text, 6])
  })

  it("survives Vditor's recordFirstPosition → addCaret text-node split", () => {
    select(text, 11, text, 6)
    chord()
    // addCaret (vditor/src/ts/undo/index.ts) inserts an empty span at the selection start and
    // removes it again, leaving the text node split at the caret.
    const span = document.createElement('span')
    getSelection()!.getRangeAt(0).insertNode(span)
    span.remove()
    collapseTo(editor, 0)
    expect(editor.querySelector('p')!.childNodes.length).toBe(2)
    // A raw node/offset snapshot would now be stale: offset 11 is past the split node's end.
    expect(text.length).toBeLessThan(11)

    expect(restoreCommandSelection()).toBe(true)
    const selection = getSelection()!
    expect(selection.toString()).toBe('world')
    // Backward: the anchor sits after the focus, so a focus→anchor range is not collapsed.
    const focusToAnchor = document.createRange()
    focusToAnchor.setStart(selection.focusNode!, selection.focusOffset)
    focusToAnchor.setEnd(selection.anchorNode!, selection.anchorOffset)
    expect(focusToAnchor.toString()).toBe('world')
  })

  it('is consumed by one command', () => {
    select(text, 6, text, 11)
    chord()
    expect(restoreCommandSelection()).toBe(true)
    collapseTo(text, 0)
    expect(restoreCommandSelection()).toBe(false)
    expect(getSelection()!.isCollapsed).toBe(true)
  })

  it.each([
    ['an untrusted keydown', () => chord({ isTrusted: false })],
    ['a composing keydown', () => chord({ isComposing: true })],
  ])('is not taken by %s', (_name, press) => {
    select(text, 6, text, 11)
    press()
    collapseTo(text, 0)
    expect(restoreCommandSelection()).toBe(false)
    expect(getSelection()!.isCollapsed).toBe(true)
  })

  it.each([
    ['pointerdown', () => fire('pointerdown')],
    ['a trusted beforeinput', () => fire('beforeinput')],
    ['a trusted input', () => fire('input')],
    ['compositionstart', () => fire('compositionstart')],
    [
      'a keydown without Ctrl/Meta/Alt',
      () => fire('keydown', { key: 'ArrowLeft', keyCode: 37, shiftKey: true }),
    ],
  ])('is invalidated by %s', (_name, invalidate) => {
    select(text, 6, text, 11)
    chord()
    invalidate()
    collapseTo(text, 0)
    expect(restoreCommandSelection()).toBe(false)
    expect(getSelection()!.isCollapsed).toBe(true)
  })

  // CP3-1b: an unbound navigation chord (Ctrl+Home) moves the caret natively. A command that
  // arrives later without its own keydown (menu, toolbar, another extension's executeCommand)
  // must act at the new caret, not at the selection from before the move.
  it("follows an unbound chord's native caret move at keyup", () => {
    select(text, 6, text, 11)
    fire('keydown', { key: 'Home', keyCode: 36, ctrlKey: true })
    collapseTo(text, 0)
    fire('keyup', { key: 'Home', keyCode: 36, ctrlKey: true })

    restoreCommandSelection()
    const selection = getSelection()!
    expect(selection.isCollapsed).toBe(true)
    expect([selection.focusNode, selection.focusOffset]).toEqual([text, 0])
  })

  it('refreshes a native selection extension at keyup, keeping its direction', () => {
    collapseTo(text, 11)
    fire('keydown', {
      key: 'ArrowLeft',
      keyCode: 37,
      ctrlKey: true,
      shiftKey: true,
    })
    select(text, 11, text, 6)
    fire('keyup', {
      key: 'ArrowLeft',
      keyCode: 37,
      ctrlKey: true,
      shiftKey: true,
    })
    collapseTo(text, 0)

    expect(restoreCommandSelection()).toBe(true)
    const selection = getSelection()!
    expect(selection.toString()).toBe('world')
    expect([selection.anchorNode, selection.anchorOffset]).toEqual([text, 11])
  })

  it('is consumed without a restore by a live-selection command (Undo)', () => {
    select(text, 6, text, 11)
    chord({ key: 'z', keyCode: 90 })
    discardCommandSelection()
    fire('keyup', { key: 'z', keyCode: 90, ctrlKey: true })
    collapseTo(text, 0)

    expect(restoreCommandSelection()).toBe(false)
    expect(getSelection()!.isCollapsed).toBe(true)
  })

  // Task 580 CP4-1: Vditor's first keydown after load splits the caret's text node and leaves an
  // empty Range across the split (P6); the keyup refresh must keep it a caret.
  it('keeps a caret whose text node a keydown split as a caret', () => {
    collapseTo(text, 3)
    fire('keydown', { key: 'Enter', keyCode: 13, ctrlKey: true })
    const tail = text.splitText(3)
    select(text, 3, tail, 0)
    expect(getSelection()!.isCollapsed).toBe(false)
    fire('keyup', { key: 'Enter', keyCode: 13, ctrlKey: true })
    collapseTo(tail, 5)

    expect(restoreCommandSelection()).toBe(true)
    const selection = getSelection()!
    expect(selection.isCollapsed).toBe(true)
    expect([selection.anchorNode, selection.anchorOffset]).toEqual([text, 3])
  })

  it('keeps an empty Range around an element as a selection', () => {
    const paragraph = editor.querySelector('p')!
    paragraph.insertBefore(document.createElement('img'), text.splitText(5))
    select(paragraph, 1, paragraph, 2)
    chord()
    collapseTo(text, 0)

    expect(restoreCommandSelection()).toBe(true)
    expect(getSelection()!.isCollapsed).toBe(false)
  })

  it('keeps the keydown selection for a command that arrives before keyup (macOS Option+Up)', () => {
    select(text, 6, text, 11)
    fire('keydown', { key: 'ArrowUp', keyCode: 38, altKey: true })
    // Chromium's macOS Option+Up moves the caret natively before Move Block's message arrives.
    collapseTo(text, 0)

    expect(restoreCommandSelection()).toBe(true)
    expect(getSelection()!.toString()).toBe('world')
    fire('keyup', { key: 'ArrowUp', keyCode: 38, altKey: true })
    expect(restoreCommandSelection()).toBe(false)
  })

  it('ignores a composing keyup', () => {
    select(text, 6, text, 11)
    chord()
    collapseTo(text, 0)
    fire('keyup', { key: 'b', keyCode: 66, ctrlKey: true, isComposing: true })

    expect(restoreCommandSelection()).toBe(true)
    expect(getSelection()!.toString()).toBe('world')
  })

  it("keeps the snapshot across VMDE's own synthetic input", () => {
    select(text, 6, text, 11)
    chord()
    fire('input', { isTrusted: false })
    expect(restoreCommandSelection()).toBe(true)
  })

  it('expires after 2 s', () => {
    vi.useFakeTimers()
    select(text, 6, text, 11)
    chord()
    vi.advanceTimersByTime(2001)
    expect(restoreCommandSelection()).toBe(false)
  })

  it('is dropped by a mode switch', () => {
    select(text, 6, text, 11)
    chord()
    const wysiwyg = document.createElement('div')
    document.body.append(wysiwyg)
    ;(window as any).vditor.vditor.currentMode = 'wysiwyg'
    ;(window as any).vditor.vditor.wysiwyg = { element: wysiwyg }
    expect(restoreCommandSelection()).toBe(false)
  })

  it('is dropped when a re-render replaces the selected block', () => {
    select(text, 6, text, 11)
    chord()
    const paragraph = editor.querySelector('p')!
    paragraph.replaceWith(paragraph.cloneNode(true))
    expect(restoreCommandSelection()).toBe(false)
  })

  it('is not taken for a selection outside the editing surface', () => {
    const outside = document.getElementById('outside')!
    outside.textContent = 'outside'
    select(outside.firstChild!, 0, outside.firstChild!, 3)
    chord()
    expect(restoreCommandSelection()).toBe(false)
  })

  it('leaves the live selection to a Command Palette route (no originating chord)', () => {
    select(text, 0, text, 5)
    // F1 opens the Palette: a keydown without a command modifier.
    fire('keydown', { key: 'F1', keyCode: 112 })
    expect(restoreCommandSelection()).toBe(false)
    expect(getSelection()!.toString()).toBe('Hello')
  })

  it('does not pull focus out of another widget when focusEditor is false', () => {
    select(text, 6, text, 11)
    chord()
    collapseTo(text, 0)
    const outside = document.getElementById('outside') as HTMLButtonElement
    outside.focus()

    expect(restoreCommandSelection(window, { focusEditor: false })).toBe(false)
    expect(document.activeElement).toBe(outside)
  })

  it('restores without moving focus when focusEditor is false and focus is on the surface', () => {
    editor.focus()
    select(text, 11, text, 6)
    chord()
    collapseTo(text, 0)

    expect(restoreCommandSelection(window, { focusEditor: false })).toBe(true)
    expect(getSelection()!.toString()).toBe('world')
    expect(getSelection()!.anchorOffset).toBe(11)
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
