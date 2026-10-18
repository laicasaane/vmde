// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  invalidateCaret,
  liveCaretIntentForTests,
  requestCaret,
  resetCaretAuthorityForTests,
  setCaretPaintabilityProbeForTests,
} from './caret'
import { installPreviewCaretRestore } from './preview-caret'

// Task 652: Preview on/off must give the editor selection back. These cases run the real button
// listeners in jsdom; the "Vditor" listener below stands in for Vditor's own handler (it flips
// `vditor-menu--current`, registered BEFORE the module under test like in the webview).

const CURRENT = 'vditor-menu--current'
const DISABLED = 'vditor-menu--disabled'

interface Fixture {
  editor: HTMLElement
  button: HTMLButtonElement
  text: Text
  second: Text
}

function mount(mode: 'ir' | 'sv' = 'ir'): Fixture {
  document.body.innerHTML =
    '<button id="pv" type="button">preview</button>' +
    '<pre id="ed" tabindex="0" contenteditable="true"><p>hello world</p><p>second line</p></pre>'
  const editor = document.getElementById('ed') as HTMLElement
  const button = document.getElementById('pv') as HTMLButtonElement
  ;(window as unknown as Record<string, unknown>).vditor = {
    vditor: { currentMode: mode, [mode]: { element: editor } },
  }
  // Vditor's own click handler: toggles the class unless the button is disabled.
  button.addEventListener('click', () => {
    if (button.classList.contains(DISABLED)) return
    button.classList.toggle(CURRENT)
  })
  const [first, second] = [
    editor.querySelectorAll('p')[0].firstChild as Text,
    editor.querySelectorAll('p')[1].firstChild as Text,
  ]
  return { editor, button, text: first, second }
}

function select(anchor: [Node, number], focus: [Node, number]): void {
  const sel = window.getSelection() as Selection
  sel.removeAllRanges()
  sel.setBaseAndExtent(anchor[0], anchor[1], focus[0], focus[1])
}

function makeDeps() {
  return {
    requestCaret: vi.fn(() => true),
    invalidateCaret: vi.fn(),
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
  resetCaretAuthorityForTests()
})
afterEach(() => {
  resetCaretAuthorityForTests()
  ;(window as unknown as Record<string, unknown>).vditor = undefined
})

describe('installPreviewCaretRestore', () => {
  it('restores a directional selection (anchor after focus) at the exact nodes', () => {
    const { editor, button, text, second } = mount()
    const deps = makeDeps()
    installPreviewCaretRestore(button, deps)
    editor.focus()
    select([second, 4], [text, 2])
    button.click()
    expect(deps.invalidateCaret).toHaveBeenCalledTimes(1)
    expect(deps.requestCaret).not.toHaveBeenCalled()
    // Preview showing: Vditor/the user changes the selection (overlay selection).
    window.getSelection()?.removeAllRanges()
    button.click()
    expect(deps.requestCaret).toHaveBeenCalledTimes(1)
    expect(deps.requestCaret).toHaveBeenCalledWith({
      anchor: { node: second, offset: 4 },
      focus: { node: text, offset: 2 },
    })
  })

  it('restores a collapsed caret as a collapsed intent', () => {
    const { editor, button, text } = mount()
    const deps = makeDeps()
    installPreviewCaretRestore(button, deps)
    editor.focus()
    select([text, 3], [text, 3])
    button.click()
    button.click()
    expect(deps.requestCaret).toHaveBeenCalledWith({ node: text, offset: 3 })
  })

  it('refocuses the editor only when it had focus at capture', () => {
    const { editor, button, text } = mount()
    const deps = makeDeps()
    installPreviewCaretRestore(button, deps)
    editor.focus()
    select([text, 1], [text, 4])
    button.click()
    // Preview hides the pane: focus falls to BODY.
    editor.blur()
    expect(document.activeElement).toBe(document.body)
    button.click()
    expect(document.activeElement).toBe(editor)
  })

  it('keeps focus on the button (keyboard activation) and still restores the selection', () => {
    const { editor, button, text } = mount()
    const deps = makeDeps()
    installPreviewCaretRestore(button, deps)
    // The selection lives in the editor, but focus is on the Preview button (focus first: jsdom,
    // unlike a browser, moves the selection onto a focused button).
    button.focus()
    select([text, 1], [text, 4])
    expect(editor.contains(document.activeElement)).toBe(false)
    button.click()
    button.click()
    expect(deps.requestCaret).toHaveBeenCalledWith({
      anchor: { node: text, offset: 1 },
      focus: { node: text, offset: 4 },
    })
    expect(document.activeElement).toBe(button)
  })

  it('writes nothing when no editor selection existed at capture', () => {
    const { button } = mount()
    const deps = makeDeps()
    installPreviewCaretRestore(button, deps)
    button.click()
    button.click()
    expect(deps.requestCaret).not.toHaveBeenCalled()
  })

  it('writes nothing when the selection was outside the editor (Split preview pane)', () => {
    const { button } = mount()
    const outside = document.createElement('p')
    outside.textContent = 'rendered pane'
    document.body.append(outside)
    const deps = makeDeps()
    installPreviewCaretRestore(button, deps)
    select([outside.firstChild as Text, 1], [outside.firstChild as Text, 5])
    button.click()
    button.click()
    expect(deps.requestCaret).not.toHaveBeenCalled()
  })

  it('falls back to clamped text offsets when the document was rebuilt in Preview (Q1 a)', () => {
    const { editor, button, text, second } = mount()
    const deps = makeDeps()
    installPreviewCaretRestore(button, deps)
    editor.focus()
    // "hello world" is 11 chars: 11 + 4 = 15 in the editor's text space.
    select([text, 2], [second, 4])
    button.click()
    // A Preview checkbox toggle / external update replaced every node.
    editor.innerHTML = '<p>hello world</p><p>second line</p>'
    button.click()
    expect(deps.requestCaret).toHaveBeenCalledWith({
      anchor: { textOffset: 2 },
      focus: { textOffset: 15 },
    })
  })

  it('restores BOTH endpoints by text offset when only one node survived', () => {
    const { editor, button, text, second } = mount()
    const deps = makeDeps()
    installPreviewCaretRestore(button, deps)
    editor.focus()
    select([text, 2], [second, 4])
    button.click()
    // Only the first paragraph is rebuilt: the anchor node is gone, the focus node is still there.
    const p = editor.querySelectorAll('p')[0]
    p.innerHTML = 'hello world'
    button.click()
    expect(deps.requestCaret).toHaveBeenCalledWith({
      anchor: { textOffset: 2 },
      focus: { textOffset: 15 },
    })
  })

  it('does not take focus from another control focused during Preview (Find input)', () => {
    const { editor, button, text } = mount()
    const input = document.createElement('input')
    document.body.append(input)
    const deps = makeDeps()
    installPreviewCaretRestore(button, deps)
    editor.focus()
    select([text, 1], [text, 4])
    button.click()
    input.focus()
    button.click()
    expect(document.activeElement).toBe(input)
    expect(deps.requestCaret).toHaveBeenCalledTimes(1)
  })

  it('falls back to text offsets when a surviving text node was shortened', () => {
    const { editor, button, text } = mount()
    const deps = makeDeps()
    installPreviewCaretRestore(button, deps)
    editor.focus()
    select([text, 2], [text, 9])
    button.click()
    text.data = 'hel'
    button.click()
    expect(deps.requestCaret).toHaveBeenCalledWith({
      anchor: { textOffset: 2 },
      focus: { textOffset: 9 },
    })
  })

  it('discards the snapshot when the editor element changed (re-init) or the mode switched', () => {
    const first = mount()
    const deps = makeDeps()
    installPreviewCaretRestore(first.button, deps)
    first.editor.focus()
    select([first.text, 1], [first.text, 4])
    first.button.click()
    const replacement = document.createElement('pre')
    ;(
      window as unknown as { vditor: { vditor: { ir: { element: Element } } } }
    ).vditor.vditor.ir.element = replacement
    first.button.click()
    expect(deps.requestCaret).not.toHaveBeenCalled()

    // Mode switch: same element object, different mode.
    const second = mount('ir')
    const deps2 = makeDeps()
    installPreviewCaretRestore(second.button, deps2)
    second.editor.focus()
    select([second.text, 1], [second.text, 4])
    second.button.click()
    ;(
      window as unknown as { vditor: { vditor: { currentMode: string } } }
    ).vditor.vditor.currentMode = 'sv'
    ;(
      window as unknown as { vditor: { vditor: Record<string, unknown> } }
    ).vditor.vditor.sv = { element: second.editor }
    second.button.click()
    expect(deps2.requestCaret).not.toHaveBeenCalled()
  })

  it('a disabled button leaves no snapshot and does not touch the caret authority', () => {
    const { editor, button, text } = mount()
    const deps = makeDeps()
    installPreviewCaretRestore(button, deps)
    editor.focus()
    select([text, 1], [text, 4])
    button.classList.add(DISABLED)
    button.click()
    expect(deps.invalidateCaret).not.toHaveBeenCalled()
    button.classList.remove(DISABLED)
    // The first real toggle now turns Preview on; off restores that one.
    button.click()
    button.click()
    expect(deps.requestCaret).toHaveBeenCalledTimes(1)
  })

  it('uses a snapshot once', () => {
    const { editor, button, text } = mount()
    const deps = makeDeps()
    installPreviewCaretRestore(button, deps)
    editor.focus()
    select([text, 1], [text, 4])
    button.click()
    button.click()
    // Second cycle without a selection must not replay the first snapshot.
    window.getSelection()?.removeAllRanges()
    button.click()
    button.click()
    expect(deps.requestCaret).toHaveBeenCalledTimes(1)
  })

  it('the disposer removes both listeners', () => {
    const { editor, button, text } = mount()
    const deps = makeDeps()
    const dispose = installPreviewCaretRestore(button, deps)
    editor.focus()
    select([text, 1], [text, 4])
    dispose()
    button.click()
    button.click()
    expect(deps.invalidateCaret).not.toHaveBeenCalled()
    expect(deps.requestCaret).not.toHaveBeenCalled()
  })

  it('retires an older live intent on, and leaves the snapshot as the live intent off', () => {
    setCaretPaintabilityProbeForTests(() => true)
    const { editor, button, text, second } = mount()
    installPreviewCaretRestore(button)
    editor.focus()
    // An older intent from some earlier caller is still live.
    requestCaret({ textOffset: 3 })
    expect(liveCaretIntentForTests()).toEqual({ textOffset: 3 })
    select([text, 2], [second, 4])
    button.click()
    expect(liveCaretIntentForTests()).toBeNull()
    button.click()
    expect(liveCaretIntentForTests()).toEqual({
      anchor: { node: text, offset: 2 },
      focus: { node: second, offset: 4 },
    })
    invalidateCaret()
  })
})
