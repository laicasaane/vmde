// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installIrWholeDocumentEdit,
  selectsWholeDocument,
} from './ir-whole-document-edit'

// Expected values come from the task contract (a whole-document selection becomes one empty
// paragraph, or the typed text; anything else stays with the browser), never from the module.

const FENCE =
  '<div data-block="0" data-type="code-block" class="vditor-ir__node">' +
  '<pre class="vditor-ir__marker--pre vditor-ir__marker"><code>const a = 1</code></pre>' +
  '<span data-type="code-block-close-marker">```</span></div>'

let editor: HTMLElement
let dispose: () => void
let inputs: InputEvent[]
let marked: number
let vditorState: { currentMode: string; ir: Record<string, unknown> }

function mount(mode = 'ir') {
  editor = document.createElement('pre')
  editor.className = 'vditor-ir vditor-reset'
  editor.setAttribute('contenteditable', 'true')
  editor.innerHTML = `<p data-block="0">first paragraph</p><p data-block="0">second paragraph</p>${FENCE}`
  document.body.append(editor)
  vditorState = { currentMode: mode, ir: { element: editor } }
  ;(window as unknown as { vditor: unknown }).vditor = { vditor: vditorState }
  inputs = []
  marked = 0
  ;(
    window as unknown as { __vmdeMarkCutInput: () => void }
  ).__vmdeMarkCutInput = () => {
    marked++
  }
  editor.addEventListener('input', (e) => inputs.push(e as InputEvent))
  dispose = installIrWholeDocumentEdit(window)
}

const selectRoot = (start = 0, end = editor.childNodes.length) => {
  const range = document.createRange()
  range.setStart(editor, start)
  range.setEnd(editor, end)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

const beforeInput = (inputType: string, data?: string, isComposing = false) => {
  const event = new InputEvent('beforeinput', {
    inputType,
    data,
    isComposing,
    bubbles: true,
    cancelable: true,
  })
  editor.dispatchEvent(event)
  return event.defaultPrevented
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.restoreAllMocks()
  dispose?.()
  window.getSelection()?.removeAllRanges()
  ;(window as unknown as { vditor?: unknown }).vditor = undefined
  ;(window as unknown as { __vmdeMarkCutInput?: unknown }).__vmdeMarkCutInput =
    undefined
})

describe('whole-document selection in IR', () => {
  it.each([
    'deleteContentForward',
    'deleteContentBackward',
    'deleteWordBackward',
  ])(
    '%s replaces every block, closing fence marker included, with one empty paragraph and one input event',
    (inputType) => {
      mount()
      selectRoot()
      expect(beforeInput(inputType)).toBe(true)
      expect(editor.innerHTML).toBe('<p data-block="0"></p>')
      const selection = window.getSelection()!
      expect(selection.isCollapsed).toBe(true)
      expect(selection.anchorNode).toBe(editor.firstChild)
      expect(inputs.map((e) => e.inputType)).toEqual(['deleteContent'])
      expect(marked).toBe(1)
    },
  )

  it('insertText empties the document to one empty paragraph with the caret in it, then leaves the insertion to the browser', () => {
    mount()
    selectRoot()
    // Not cancelled and no synthetic input: the native insertion and its input event follow, so
    // whitespace keeps its native handling and Vditor records its own Undo snapshot.
    expect(beforeInput('insertText', 'X')).toBe(false)
    expect(editor.innerHTML).toBe('<p data-block="0"></p>')
    const selection = window.getSelection()!
    expect(selection.isCollapsed).toBe(true)
    expect(selection.anchorNode).toBe(editor.firstChild)
    expect(selection.anchorOffset).toBe(0)
    expect(inputs).toEqual([])
    expect(marked).toBe(1)
  })

  it.each([' ', 'X ', ' X'])(
    'insertText %j gets the same route and no raw text is written',
    (data) => {
      mount()
      selectRoot()
      expect(beforeInput('insertText', data)).toBe(false)
      expect(editor.textContent).toBe('')
      expect(inputs).toEqual([])
    },
  )

  it('selectsWholeDocument needs one Range from the root start to the root child count', () => {
    mount()
    const selection = window.getSelection()!
    selectRoot()
    expect(selectsWholeDocument(editor, selection)).toBe(true)
    selectRoot(0, editor.childNodes.length - 1)
    expect(selectsWholeDocument(editor, selection)).toBe(false)
    selectRoot(1)
    expect(selectsWholeDocument(editor, selection)).toBe(false)
    selection.removeAllRanges()
    expect(selectsWholeDocument(editor, selection)).toBe(false)
  })
})

describe('everything else stays with the browser and Vditor', () => {
  it('a partial selection is not intercepted and the DOM is untouched', () => {
    mount()
    const before = editor.innerHTML
    selectRoot(0, editor.childNodes.length - 1)
    expect(beforeInput('deleteContentForward')).toBe(false)
    expect(beforeInput('insertText', 'X')).toBe(false)
    expect(editor.innerHTML).toBe(before)
    expect(inputs).toEqual([])
  })

  it('a selection inside a code block (Select All inside a fence) is not intercepted', () => {
    mount()
    const before = editor.innerHTML
    const code = editor.querySelector('code')!
    const range = document.createRange()
    range.selectNodeContents(code)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(beforeInput('deleteContentBackward')).toBe(false)
    expect(editor.innerHTML).toBe(before)
  })

  it('a caret is not intercepted', () => {
    mount()
    const before = editor.innerHTML
    const range = document.createRange()
    range.setStart(editor.firstChild!.firstChild!, 3)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(beforeInput('deleteContentBackward')).toBe(false)
    expect(editor.innerHTML).toBe(before)
  })

  it('IME composition over a whole-document selection is not intercepted', () => {
    mount()
    const before = editor.innerHTML
    selectRoot()
    expect(beforeInput('insertText', 'x', true)).toBe(false)
    expect(beforeInput('insertCompositionText', 'x')).toBe(false)
    vditorState.ir.composingLock = true
    expect(beforeInput('deleteContentBackward')).toBe(false)
    expect(editor.innerHTML).toBe(before)
    expect(inputs).toEqual([])
  })

  it.each([
    'insertParagraph',
    'insertFromPaste',
    'deleteByCut',
    'insertLineBreak',
  ])('%s over a whole-document selection is not intercepted', (inputType) => {
    mount()
    const before = editor.innerHTML
    selectRoot()
    expect(beforeInput(inputType, 'x')).toBe(false)
    expect(editor.innerHTML).toBe(before)
  })

  it.each(['wysiwyg', 'sv'])('%s mode is not intercepted', (mode) => {
    mount(mode)
    const before = editor.innerHTML
    selectRoot()
    expect(beforeInput('deleteContentForward')).toBe(false)
    expect(editor.innerHTML).toBe(before)
  })

  it('an event from outside the editor is not intercepted', () => {
    mount()
    const before = editor.innerHTML
    selectRoot()
    const field = document.createElement('input')
    document.body.append(field)
    const event = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true,
      cancelable: true,
    })
    field.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(editor.innerHTML).toBe(before)
  })

  it('the disposer removes the listener', () => {
    mount()
    dispose()
    selectRoot()
    expect(beforeInput('deleteContentForward')).toBe(false)
  })
})
