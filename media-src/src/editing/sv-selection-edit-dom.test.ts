// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installSvSelectionEdit } from './sv-selection-edit-dom'

// Expected sources come from the task contract (the selected characters go; no `\n` outside the
// selection goes), never from the module under test.
const ORIGINAL = 'Alpha line\nBravo line\nCharlie line\n'

const NEWLINE =
  '<span data-type="newline"><br><span style="display: none">\n</span></span>'
const line = (text: string) =>
  (text ? `<span data-type="text">${text}</span>` : '') + NEWLINE

/** The SV editable the way Lute renders it: one `div[data-block]` per paragraph, a newline span per line. */
function editorOf(blocks: string[][]): HTMLElement {
  const editor = document.createElement('pre')
  editor.className = 'vditor-sv vditor-reset'
  editor.setAttribute('contenteditable', 'true')
  editor.innerHTML = blocks
    .map((lines) => `<div data-block="0">${lines.map(line).join('')}</div>`)
    .join('')
  document.body.append(editor)
  return editor
}

const textNodeWith = (editor: HTMLElement, needle: string): Text => {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if ((n.textContent ?? '').includes(needle)) return n as Text
  throw new Error(`"${needle}" not found`)
}

function select(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
) {
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

/** Selects `word` inside its text node. */
function selectWord(editor: HTMLElement, word: string) {
  const node = textNodeWith(editor, word)
  const i = (node.textContent ?? '').indexOf(word)
  select(node, i, node, i + word.length)
}

/** Caret offset in the editor's textContent. */
function caretOffset(editor: HTMLElement): number {
  const selection = window.getSelection()!
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.setEnd(selection.focusNode!, selection.focusOffset)
  return range.toString().length
}

function fire(
  target: Element,
  type: string,
  init: InputEventInit,
): { event: InputEvent; prevented: boolean } {
  const event = new InputEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return { event, prevented: event.defaultPrevented }
}

const beforeInput = (editor: HTMLElement, inputType: string, data?: string) =>
  fire(editor, 'beforeinput', { inputType, data })

const backspace = (target: Element, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', {
    key: 'Backspace',
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

let editor: HTMLElement
let dispose: () => void
let inputs: InputEvent[]
let vditorState: { currentMode: string; sv: Record<string, unknown> }

function mount(blocks: string[][]) {
  editor = editorOf(blocks)
  vditorState = { currentMode: 'sv', sv: { element: editor } }
  ;(window as unknown as { vditor: unknown }).vditor = { vditor: vditorState }
  inputs = []
  editor.addEventListener('input', (e) => inputs.push(e as InputEvent))
  dispose = installSvSelectionEdit(window)
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

describe('beforeinput over an owned selection', () => {
  it('Delete over Bravo removes only Bravo, keeps the caret there and sends one input event', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo')
    const { prevented } = beforeInput(editor, 'deleteContentForward')
    expect(prevented).toBe(true)
    expect(editor.textContent).toBe('Alpha line\n line\nCharlie line\n')
    expect(caretOffset(editor)).toBe('Alpha line\n'.length)
    expect(window.getSelection()!.isCollapsed).toBe(true)
    // Not the native backward type: Vditor's SV input path would skip its re-spin at a line start.
    expect(inputs.map((e) => e.inputType)).toEqual(['deleteContent'])
  })

  it('deleteContentBackward takes the same route', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo')
    expect(beforeInput(editor, 'deleteContentBackward').prevented).toBe(true)
    expect(editor.textContent).toBe('Alpha line\n line\nCharlie line\n')
  })

  it('deleteByCut keeps its own type for the input event', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo')
    expect(beforeInput(editor, 'deleteByCut').prevented).toBe(true)
    expect(inputs.map((e) => e.inputType)).toEqual(['deleteByCut'])
  })

  it.each([
    'deleteWordBackward',
    'deleteWordForward',
    'deleteSoftLineBackward',
    'deleteSoftLineForward',
    'deleteHardLineBackward',
    'deleteHardLineForward',
  ])('%s over an owned selection deletes exactly the selection', (type) => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo')
    expect(beforeInput(editor, type).prevented).toBe(true)
    expect(editor.textContent).toBe('Alpha line\n line\nCharlie line\n')
    expect(inputs.map((e) => e.inputType)).toEqual(['deleteContent'])
  })

  it('a word delete over a selection that is not owned stays native', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'ravo')
    expect(beforeInput(editor, 'deleteWordBackward').prevented).toBe(false)
    expect(editor.textContent).toBe(ORIGINAL)
  })

  it('the whole content of a line leaves an empty line', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo line')
    beforeInput(editor, 'deleteContentForward')
    expect(editor.textContent).toBe('Alpha line\n\nCharlie line\n')
  })

  it('a whole line with its newline span removes the line', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    const node = textNodeWith(editor, 'Bravo line')
    const newline = node.parentElement!.nextElementSibling!
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEndAfter(newline)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    beforeInput(editor, 'deleteContentForward')
    expect(editor.textContent).toBe('Alpha line\nCharlie line\n')
    expect(caretOffset(editor)).toBe('Alpha line\n'.length)
  })

  it('a selection that starts on an element boundary just after the previous newline span is owned', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    const block = editor.firstElementChild!
    const bravo = textNodeWith(editor, 'Bravo line').parentElement!
    // (block, index of the Bravo span) is "after the previous newline span", the shape a drag makes.
    select(
      block,
      Array.from(block.childNodes).indexOf(bravo),
      bravo.firstChild!,
      5,
    )
    beforeInput(editor, 'deleteContentForward')
    expect(editor.textContent).toBe('Alpha line\n line\nCharlie line\n')
  })

  it('type-over inserts the typed text in place of the selection', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo')
    const { prevented } = beforeInput(editor, 'insertText', 'X')
    expect(prevented).toBe(true)
    expect(editor.textContent).toBe('Alpha line\nX line\nCharlie line\n')
    expect(caretOffset(editor)).toBe('Alpha line\nX'.length)
    expect(inputs.map((e) => [e.inputType, e.data])).toEqual([
      ['insertText', 'X'],
    ])
  })

  it('a selection across paragraph blocks merges them in source order', () => {
    mount([['Alpha', ''], ['Bravo line', ''], ['Charlie line']])
    const bravo = textNodeWith(editor, 'Bravo line')
    const charlie = textNodeWith(editor, 'Charlie line')
    select(bravo, 0, charlie, 'Char'.length)
    beforeInput(editor, 'deleteContentForward')
    expect(editor.textContent).toBe('Alpha\n\nlie line\n')
    expect(editor.querySelectorAll('[data-block]').length).toBe(2)
    expect(caretOffset(editor)).toBe('Alpha\n\n'.length)
  })

  it('a selection that starts at the very start of a later block merges it into the block it starts in', () => {
    mount([['Alpha', ''], ['Bravo line', ''], ['Charlie line']])
    const second = editor.children[1]
    const charlie = textNodeWith(editor, 'Charlie line')
    select(second, 0, charlie, 'Char'.length)
    beforeInput(editor, 'deleteContentForward')
    expect(editor.textContent).toBe('Alpha\n\nlie line\n')
  })
})

describe('what stays native', () => {
  const untouched = (name: string, prepare: () => void) =>
    it(name, () => {
      mount([['Alpha line', 'Bravo line', 'Charlie line']])
      const before = editor.innerHTML
      prepare()
      const { prevented } = beforeInput(editor, 'deleteContentForward')
      expect(prevented).toBe(false)
      expect(editor.innerHTML).toBe(before)
      expect(inputs).toEqual([])
    })

  untouched('a mid-line selection', () => selectWord(editor, 'ravo'))
  untouched('a first-line selection', () => selectWord(editor, 'Alpha'))
  untouched('a collapsed caret', () => {
    const node = textNodeWith(editor, 'Bravo')
    select(node, 2, node, 2)
  })
  untouched('a whole-document selection', () => {
    const range = document.createRange()
    range.selectNodeContents(editor)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
  })

  it('paste over an owned selection', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo')
    expect(beforeInput(editor, 'insertFromPaste', 'Z').prevented).toBe(false)
    expect(editor.textContent).toBe(ORIGINAL)
  })

  it('an insertText without data', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo')
    expect(beforeInput(editor, 'insertText').prevented).toBe(false)
    expect(editor.textContent).toBe(ORIGINAL)
  })

  it('an IME composition', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo')
    vditorState.sv.composingLock = true
    expect(beforeInput(editor, 'insertText', 'X').prevented).toBe(false)
    const composing = fire(editor, 'beforeinput', {
      inputType: 'insertCompositionText',
      data: 'X',
      isComposing: true,
    })
    expect(composing.prevented).toBe(false)
    expect(editor.textContent).toBe(ORIGINAL)
  })

  it('an event from a field outside the editor that keeps a stale editor selection', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo')
    const field = document.createElement('input')
    document.body.append(field)
    expect(
      fire(field, 'beforeinput', { inputType: 'deleteContentForward' })
        .prevented,
    ).toBe(false)
    expect(editor.textContent).toBe(ORIGINAL)
  })

  it('any other editor mode', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo')
    vditorState.currentMode = 'ir'
    expect(beforeInput(editor, 'deleteContentForward').prevented).toBe(false)
    expect(editor.textContent).toBe(ORIGINAL)
  })
})

describe('Backspace keydown', () => {
  it('takes an owned selection before Vditor and stops it reaching the editor', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    const reached = vi.fn()
    editor.addEventListener('keydown', reached)
    selectWord(editor, 'Bravo')
    const event = backspace(editor)
    expect(event.defaultPrevented).toBe(true)
    expect(reached).not.toHaveBeenCalled()
    expect(editor.textContent).toBe('Alpha line\n line\nCharlie line\n')
    expect(inputs.map((e) => e.inputType)).toEqual(['deleteContent'])
  })

  it('leaves a selection it does not own to Vditor', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    const reached = vi.fn()
    editor.addEventListener('keydown', reached)
    selectWord(editor, 'ravo')
    expect(backspace(editor).defaultPrevented).toBe(false)
    expect(reached).toHaveBeenCalledTimes(1)
    expect(editor.textContent).toBe(ORIGINAL)
  })

  it.each([
    ['Shift', { shiftKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Alt', { altKey: true }],
    ['Meta', { metaKey: true }],
  ])('ignores Backspace with %s held', (_name, init) => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo')
    expect(backspace(editor, init).defaultPrevented).toBe(false)
    expect(editor.textContent).toBe(ORIGINAL)
  })

  it('ignores other keys', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo')
    const event = new KeyboardEvent('keydown', {
      key: 'Delete',
      bubbles: true,
      cancelable: true,
    })
    editor.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(editor.textContent).toBe(ORIGINAL)
  })
})

describe('window.__vmdeSvOwnedDelete (the cut bridge)', () => {
  const hook = () =>
    (window as unknown as { __vmdeSvOwnedDelete: () => boolean })
      .__vmdeSvOwnedDelete

  it('deletes an owned selection synchronously, after marking user input, and says so', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    const order: string[] = []
    ;(
      window as unknown as { __vmdeMarkCutInput: () => void }
    ).__vmdeMarkCutInput = () => order.push(`mark:${editor.textContent}`)
    selectWord(editor, 'Bravo')
    expect(hook()()).toBe(true)
    expect(order).toEqual([`mark:${ORIGINAL}`])
    expect(editor.textContent).toBe('Alpha line\n line\nCharlie line\n')
    expect(inputs.map((e) => e.inputType)).toEqual(['deleteByCut'])
  })

  it('returns false and leaves the DOM alone for a selection it does not own', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'ravo')
    expect(hook()()).toBe(false)
    expect(editor.textContent).toBe(ORIGINAL)
    expect(inputs).toEqual([])
  })

  it('returns false for an empty but non-collapsed range', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    const node = textNodeWith(editor, 'Bravo')
    select(node, 0, node, 0)
    expect(hook()()).toBe(false)
  })

  it('survives a re-init: installing again and disposing the first instance keeps the new hook', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    const first = dispose
    const firstHook = hook()
    // Disposables.set installs the new instance, then runs the previous disposer.
    dispose = installSvSelectionEdit(window)
    const secondHook = hook()
    expect(secondHook).not.toBe(firstHook)
    first()
    expect(hook()).toBe(secondHook)
    selectWord(editor, 'Bravo')
    expect(hook()()).toBe(true)
    expect(editor.textContent).toBe('Alpha line\n line\nCharlie line\n')
    // The first instance's listeners are gone, the second's still work (one edit, one input).
    selectWord(editor, 'Charlie')
    expect(beforeInput(editor, 'deleteContentForward').prevented).toBe(true)
    expect(inputs.length).toBe(2)
  })

  it('is removed by the disposer together with the listeners', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    dispose()
    expect(hook()).toBeUndefined()
    selectWord(editor, 'Bravo')
    expect(beforeInput(editor, 'deleteContentForward').prevented).toBe(false)
    expect(backspace(editor).defaultPrevented).toBe(false)
    expect(editor.textContent).toBe(ORIGINAL)
  })
})

describe('a failure after the DOM changed', () => {
  it('still cancels the native edit and sends the input event once', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo')
    const selection = window.getSelection()!
    vi.spyOn(selection, 'addRange').mockImplementation(() => {
      throw new Error('selection refused')
    })
    expect(beforeInput(editor, 'deleteContentForward').prevented).toBe(true)
    expect(editor.textContent).toBe('Alpha line\n line\nCharlie line\n')
    expect(inputs.map((e) => e.inputType)).toEqual(['deleteContent'])
  })

  it('does the same for Backspace: Vditor never sees the key', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    const reached = vi.fn()
    editor.addEventListener('keydown', reached)
    selectWord(editor, 'Bravo')
    vi.spyOn(window.getSelection()!, 'addRange').mockImplementation(() => {
      throw new Error('selection refused')
    })
    expect(backspace(editor).defaultPrevented).toBe(true)
    expect(reached).not.toHaveBeenCalled()
    expect(inputs.length).toBe(1)
  })

  it('the cut bridge still reports the selection as deleted', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    selectWord(editor, 'Bravo')
    vi.spyOn(window.getSelection()!, 'addRange').mockImplementation(() => {
      throw new Error('selection refused')
    })
    const hook = (window as unknown as { __vmdeSvOwnedDelete: () => boolean })
      .__vmdeSvOwnedDelete
    expect(hook()).toBe(true)
    expect(inputs.length).toBe(1)
  })
})

describe('caret after Vditor re-spins', () => {
  // Vditor's input handler replaces the block and puts its caret back by its own rules; jsdom has no
  // Vditor, so a listener plays that part.
  const respinTo = (place: () => void) =>
    editor.addEventListener('input', place)

  it('puts the caret back at the edit when the re-spun text is the model text and Vditor moved it', () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    respinTo(() => {
      const node = textNodeWith(editor, 'Alpha line')
      select(node, 'Alpha line'.length, node, 'Alpha line'.length)
    })
    selectWord(editor, 'Bravo')
    beforeInput(editor, 'deleteContentForward')
    expect(window.getSelection()!.isCollapsed).toBe(true)
    expect(caretOffset(editor)).toBe('Alpha line\n'.length)
    // The start of the next line, not the end of the line before it.
    expect(window.getSelection()!.focusNode?.textContent).toBe(' line')
  })

  it("leaves Vditor's caret alone when the re-spin reformatted the text", () => {
    mount([['Alpha line', 'Bravo line', 'Charlie line']])
    respinTo(() => {
      textNodeWith(editor, 'Alpha line').data = 'Alpha lines'
      const node = textNodeWith(editor, 'Alpha lines')
      select(node, 0, node, 0)
    })
    selectWord(editor, 'Bravo')
    beforeInput(editor, 'deleteContentForward')
    expect(caretOffset(editor)).toBe(0)
  })
})
