// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  codeBlockOfPreview,
  codeEndPosition,
  editableCodeOf,
  setupCodeBlockPreviewEnter,
} from './code-block-enter'

// The decision half of the Enter relocation against hand-built IR/WYSIWYG code-block DOM (shapes
// measured in the Chromium harness, tasks/627). That Vditor's own Enter rule then keeps the newline
// in the code is behaviour of the real editor: media-src/e2e/code-block-enter-preview-caret.spec.ts.

const PREVIEW_INNER =
  '<div class="vditor-copy"></div><code class="hljs">const echo = 1\n</code><span>​</span>'
const IR_BLOCK = `<div data-type="code-block" class="vditor-ir__node"><span data-type="code-block-open-marker">\`\`\`</span><pre class="vditor-ir__marker--pre vditor-ir__marker"><code class="language-js">const echo = 1\n</code></pre><pre class="vditor-ir__preview" data-render="1">${PREVIEW_INNER}</pre><span data-type="code-block-close-marker">\`\`\`</span></div>`
const WYS_BLOCK = `<div class="vditor-wysiwyg__block" data-type="code-block"><pre class="vditor-wysiwyg__pre" style="display:none"><code class="language-js">const echo = 1\n</code></pre><pre class="vditor-wysiwyg__preview" data-render="1">${PREVIEW_INNER}</pre></div>`
// A math block shares the `__preview` class with code blocks but has no editable code to move into.
const IR_MATH =
  '<div data-type="math-block" class="vditor-ir__node"><pre class="vditor-ir__marker--pre vditor-ir__marker"><code>x</code></pre><pre class="vditor-ir__preview" data-render="1"><span>x</span></pre></div>'

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

function mount(html: string): HTMLElement {
  const editor = document.createElement('div')
  editor.innerHTML = `<p>Alpha</p>${html}`
  document.body.append(editor)
  return editor
}

function caretAt(node: Node, offset: number): void {
  const selection = window.getSelection()!
  selection.removeAllRanges()
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  selection.addRange(range)
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  document.body.querySelector('div')!.dispatchEvent(event)
  return event
}

const selectionNode = () => window.getSelection()!.anchorNode
const selectionOffset = () => window.getSelection()!.anchorOffset

describe('codeBlockOfPreview / editableCodeOf', () => {
  it.each([
    ['IR', IR_BLOCK, '.vditor-ir__preview', '.vditor-ir__marker--pre code'],
    [
      'WYSIWYG',
      WYS_BLOCK,
      '.vditor-wysiwyg__preview',
      '.vditor-wysiwyg__pre code',
    ],
  ])(
    '%s: a node inside the preview resolves to the block and its editable code',
    (_name, html, previewSel, codeSel) => {
      const editor = mount(html)
      const inner = editor.querySelector(`${previewSel} code`)!.firstChild!
      const block = codeBlockOfPreview(inner)!
      expect(block.dataset.type).toBe('code-block')
      expect(editableCodeOf(block)).toBe(editor.querySelector(codeSel))
    },
  )

  it('a node in the editable code, a paragraph or a math preview is not a code-block preview', () => {
    const editor = mount(IR_BLOCK + IR_MATH)
    expect(
      codeBlockOfPreview(
        editor.querySelector('.vditor-ir__marker--pre code')!.firstChild,
      ),
    ).toBeNull()
    expect(codeBlockOfPreview(editor.querySelector('p')!.firstChild)).toBeNull()
    expect(
      codeBlockOfPreview(
        editor.querySelector(
          '[data-type="math-block"] .vditor-ir__preview span',
        )!.firstChild,
      ),
    ).toBeNull()
    expect(codeBlockOfPreview(null)).toBeNull()
  })
})

describe('codeEndPosition', () => {
  it('puts the caret after the last non-newline character, before the trailing newline', () => {
    const editor = mount(IR_BLOCK)
    const code = editor.querySelector<HTMLElement>(
      '.vditor-ir__marker--pre code',
    )!
    expect(codeEndPosition(code)).toEqual({
      node: code.firstChild,
      offset: 'const echo = 1'.length,
    })
  })

  it('uses the last text node holding content when the newline is a separate node', () => {
    const code = document.createElement('code')
    code.append('one\ntwo', '\n', '\n')
    expect(codeEndPosition(code)).toEqual({
      node: code.firstChild,
      offset: 'one\ntwo'.length,
    })
  })

  it('falls back to the first position for empty code', () => {
    const onlyNewline = document.createElement('code')
    onlyNewline.append('\n')
    expect(codeEndPosition(onlyNewline)).toEqual({
      node: onlyNewline.firstChild,
      offset: 0,
    })
    const none = document.createElement('code')
    expect(codeEndPosition(none)).toEqual({ node: none, offset: 0 })
  })
})

describe('setupCodeBlockPreviewEnter', () => {
  it.each([
    ['IR', IR_BLOCK, '.vditor-ir__preview', '.vditor-ir__marker--pre code'],
    [
      'WYSIWYG',
      WYS_BLOCK,
      '.vditor-wysiwyg__preview',
      '.vditor-wysiwyg__pre code',
    ],
  ])(
    '%s: Enter with the caret in the preview moves it to the end of the code, and the event goes on',
    (_name, html, previewSel, codeSel) => {
      const editor = mount(html)
      dispose = setupCodeBlockPreviewEnter(() => editor)
      const zwsp = editor.querySelector(`${previewSel} > span`)!.firstChild!
      caretAt(zwsp, 1)
      const event = press({ key: 'Enter' })
      const code = editor.querySelector(codeSel)!
      expect(selectionNode()).toBe(code.firstChild)
      expect(selectionOffset()).toBe('const echo = 1'.length)
      expect(window.getSelection()!.isCollapsed).toBe(true)
      expect(event.defaultPrevented).toBe(false)
    },
  )

  it('leaves the caret alone for every other key, modifier, selection and mode', () => {
    const editor = mount(IR_BLOCK)
    let active: HTMLElement | null = editor
    dispose = setupCodeBlockPreviewEnter(() => active)
    const zwsp = editor.querySelector('.vditor-ir__preview > span')!.firstChild!
    const stays = (init: KeyboardEventInit) => {
      caretAt(zwsp, 1)
      press(init)
      expect(selectionNode()).toBe(zwsp)
      expect(selectionOffset()).toBe(1)
    }
    stays({ key: 'y' })
    stays({ key: 'ArrowDown' })
    stays({ key: 'Enter', shiftKey: true })
    stays({ key: 'Enter', ctrlKey: true })
    stays({ key: 'Enter', metaKey: true })
    stays({ key: 'Enter', altKey: true })
    stays({ key: 'Enter', isComposing: true })
    stays({ key: 'Enter', keyCode: 229 })
    // A range selection is not moved.
    const range = document.createRange()
    range.setStart(zwsp, 0)
    range.setEnd(zwsp, 1)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    press({ key: 'Enter' })
    expect(window.getSelection()!.isCollapsed).toBe(false)
    // No block editor (source mode): nothing happens.
    active = null
    stays({ key: 'Enter' })
  })

  it('does not touch a caret in the editable code, a paragraph or outside the editor', () => {
    const editor = mount(IR_BLOCK)
    dispose = setupCodeBlockPreviewEnter(() => editor)
    const codeText = editor.querySelector('.vditor-ir__marker--pre code')!
      .firstChild!
    caretAt(codeText, 3)
    press({ key: 'Enter' })
    expect(selectionNode()).toBe(codeText)
    expect(selectionOffset()).toBe(3)
    const paragraphText = editor.querySelector('p')!.firstChild!
    caretAt(paragraphText, 5)
    press({ key: 'Enter' })
    expect(selectionNode()).toBe(paragraphText)
    const outside = mount(IR_BLOCK)
    const outsideZwsp = outside.querySelector('.vditor-ir__preview > span')!
      .firstChild!
    caretAt(outsideZwsp, 1)
    press({ key: 'Enter' })
    expect(selectionNode()).toBe(outsideZwsp)
  })

  it('the disposer removes the listener', () => {
    const editor = mount(IR_BLOCK)
    setupCodeBlockPreviewEnter(() => editor)()
    const zwsp = editor.querySelector('.vditor-ir__preview > span')!.firstChild!
    caretAt(zwsp, 1)
    press({ key: 'Enter' })
    expect(selectionNode()).toBe(zwsp)
  })
})
