// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  checkpointUndoBoundary,
  installUndoBoundaries,
  isUndoBoundaryCommand,
  isSyntaxPromotionText,
  markToolbarHotkeyKeydownBridged,
  takeEditorActionUndoBoundary,
} from './undo-boundaries'

describe('undo grouping boundaries', () => {
  it.each(['# ', '### ', '- ', '* ', '> ', '1. '])(
    'recognizes the literal syntax promotion %j',
    (text) => expect(isSyntaxPromotionText(text)).toBe(true),
  )

  it.each(['plain ', '# title ', '1. item ', ''])(
    'does not split ordinary typing for %j',
    (text) => expect(isSyntaxPromotionText(text)).toBe(false),
  )

  it('cancels a pending merged checkpoint before adding a forced boundary', () => {
    const addToUndoStack = vi.fn()
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    const inner = {
      currentMode: 'ir' as const,
      ir: { processTimeoutId: 42 },
      undo: { addToUndoStack },
    }

    checkpointUndoBoundary(inner, true)

    expect(clear).toHaveBeenCalledWith(42)
    expect(addToUndoStack).toHaveBeenCalledWith(inner)
    clear.mockRestore()
  })

  it('adds the post-action checkpoint without cancelling edit-sync work', () => {
    const addToUndoStack = vi.fn()
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    const inner = {
      currentMode: 'wysiwyg' as const,
      wysiwyg: { afterRenderTimeoutId: 77 },
      undo: { addToUndoStack },
    }

    checkpointUndoBoundary(inner, false)

    expect(clear).not.toHaveBeenCalled()
    expect(addToUndoStack).toHaveBeenCalledWith(inner)
    clear.mockRestore()
  })

  it.each([
    [{ key: 'b', ctrlKey: true }, true],
    [{ key: 'f', ctrlKey: true, shiftKey: true }, false],
    [{ key: 'h', ctrlKey: true }, false],
    [{ key: 'h', metaKey: true }, true],
    [{ key: '=', ctrlKey: true }, true],
    [{ key: 'c', ctrlKey: true }, false],
    [{ key: 'x', ctrlKey: true }, false],
    [{ key: 'v', ctrlKey: true }, false],
    [{ key: 'z', ctrlKey: true }, false],
    [{ key: 'y', ctrlKey: true }, false],
    [{ key: 'z', ctrlKey: true, shiftKey: true }, false],
  ])(
    'classifies mutating model/table chords without duplicating clipboard/history %j',
    (partial, expected) => {
      const event = new KeyboardEvent('keydown', partial)
      expect(isUndoBoundaryCommand(event)).toBe(expected)
    },
  )

  // Task 580 CP2-2 — the dispatcher's boundary hook. No action is listed yet: each conversion
  // step lists its action when it removes the action's key from MODEL_COMMAND_KEYS.
  describe('editor-action boundary hook', () => {
    function installWithStack() {
      const addToUndoStack = vi.fn()
      const input = vi.fn()
      const inner = {
        currentMode: 'ir' as const,
        options: { undoDelay: 800, input },
        ir: {},
        undo: { addToUndoStack, ir: { undoStack: [] } },
      }
      const dispose = installUndoBoundaries(
        { vditor: inner, getValue: () => '# doc\n' } as any,
        window,
      )
      return { addToUndoStack, input, dispose }
    }

    it('takes no boundary for an action that is not listed', () => {
      vi.useFakeTimers()
      const { addToUndoStack, input, dispose } = installWithStack()
      expect(takeEditorActionUndoBoundary('table-align-center')).toBe(false)
      vi.runAllTimers()
      expect(addToUndoStack).not.toHaveBeenCalled()
      expect(input).not.toHaveBeenCalled()
      dispose()
      vi.useRealTimers()
    })

    it("takes the installed editor's boundary for a listed action, once", () => {
      vi.useFakeTimers()
      const { addToUndoStack, input, dispose } = installWithStack()
      const listed = new Set(['table-align-center'] as const)
      expect(takeEditorActionUndoBoundary('table-align-center', listed)).toBe(
        true,
      )
      vi.runAllTimers()
      expect(addToUndoStack).toHaveBeenCalledTimes(1)
      expect(input).toHaveBeenCalledWith('# doc\n')
      dispose()
      expect(takeEditorActionUndoBoundary('table-align-center', listed)).toBe(
        false,
      )
      vi.useRealTimers()
    })

    it('keeps the key-based boundary for keys that have not migrated', () => {
      vi.useFakeTimers()
      const { addToUndoStack, dispose } = installWithStack()
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '=', ctrlKey: true }),
      )
      vi.runAllTimers()
      expect(addToUndoStack).toHaveBeenCalledTimes(1)
      dispose()
      vi.useRealTimers()
    })
  })

  it('does not add a second boundary for the host-bridged toolbar click of one hotkey', () => {
    vi.useFakeTimers()
    const toolbar = document.createElement('div')
    toolbar.className = 'vditor-toolbar'
    const button = document.createElement('button')
    toolbar.append(button)
    document.body.append(toolbar)
    const addToUndoStack = vi.fn()
    const inner = {
      currentMode: 'ir' as const,
      options: { undoDelay: 800, input: vi.fn() },
      ir: {},
      undo: { addToUndoStack, ir: { undoStack: [] } },
    }
    const dispose = installUndoBoundaries(
      { vditor: inner, getValue: () => '# doc\n' } as any,
      window,
    )

    const keydown = new KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      bubbles: true,
    })
    markToolbarHotkeyKeydownBridged(keydown)
    window.dispatchEvent(keydown)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    vi.runAllTimers()

    expect(addToUndoStack).toHaveBeenCalledTimes(1)
    dispose()
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it.each([
    ['edit-mode trigger', 'vditor-toolbar', 'edit-mode', undefined],
    ['SV mode choice', 'vditor-panel', undefined, 'sv'],
    ['WYSIWYG mode choice', 'vditor-panel', undefined, 'wysiwyg'],
  ])(
    'does not synthesize a source edit for the %s',
    (_name, className, actionType, modeChoice) => {
      vi.useFakeTimers()
      const container = document.createElement('div')
      container.className = className
      const button = document.createElement('button')
      if (actionType) button.dataset.type = actionType
      if (modeChoice) button.dataset.mode = modeChoice
      container.append(button)
      document.body.append(container)
      const input = vi.fn()
      const addToUndoStack = vi.fn()
      const inner = {
        currentMode: 'ir' as 'ir' | 'sv' | 'wysiwyg',
        options: { undoDelay: 800, input },
        ir: {},
        sv: {},
        wysiwyg: {},
        undo: {
          addToUndoStack,
          ir: { undoStack: ['earlier'] },
          sv: { undoStack: [] },
          wysiwyg: { undoStack: [] },
        },
      }
      const dispose = installUndoBoundaries(
        { vditor: inner, getValue: () => '# doc\n\n' } as any,
        window,
      )

      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      inner.currentMode = modeChoice === 'sv' ? 'sv' : 'wysiwyg'
      vi.runAllTimers()

      expect(input).not.toHaveBeenCalled()
      expect(addToUndoStack).not.toHaveBeenCalled()
      dispose()
      vi.useRealTimers()
      document.body.replaceChildren()
    },
  )
  it('does not synthesize a source edit for the full Preview toolbar toggle', () => {
    vi.useFakeTimers()
    const toolbar = document.createElement('div')
    toolbar.className = 'vditor-toolbar'
    const button = document.createElement('button')
    button.dataset.type = 'preview'
    toolbar.append(button)
    document.body.append(toolbar)
    const input = vi.fn()
    const inner = {
      currentMode: 'ir' as const,
      options: { undoDelay: 800, input },
      ir: {},
      undo: { addToUndoStack: vi.fn(), ir: { undoStack: [] } },
    }
    const dispose = installUndoBoundaries(
      { vditor: inner, getValue: () => '# doc\n' } as any,
      window,
    )

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    vi.runAllTimers()

    expect(input).not.toHaveBeenCalled()
    dispose()
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('retains the source-edit boundary for formatting toolbar actions', () => {
    vi.useFakeTimers()
    const toolbar = document.createElement('div')
    toolbar.className = 'vditor-toolbar'
    const button = document.createElement('button')
    button.dataset.type = 'bold'
    toolbar.append(button)
    document.body.append(toolbar)
    const input = vi.fn()
    const inner = {
      currentMode: 'ir' as const,
      options: { undoDelay: 800, input },
      ir: {},
      undo: { addToUndoStack: vi.fn(), ir: { undoStack: [] } },
    }
    const dispose = installUndoBoundaries(
      { vditor: inner, getValue: () => '# doc\n' } as any,
      window,
    )

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    vi.runAllTimers()

    expect(input).toHaveBeenCalledOnce()
    dispose()
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it.each(['ir', 'wysiwyg', 'sv'] as const)(
    'keeps Find input gestures out of editor history and host source in %s',
    (mode) => {
      vi.useFakeTimers()
      const widget = document.createElement('div')
      widget.className = 'vmde-find-replace'
      const find = document.createElement('input')
      widget.append(find)
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      document.body.append(editor, widget)
      const exact = 'alpha\r\n'
      let host = exact
      const input = vi.fn((markdown: string) => {
        host = markdown
      })
      const addToUndoStack = vi.fn()
      const getValue = vi.fn(() => 'alpha\n')
      const inner = {
        currentMode: mode,
        options: { undoDelay: 800, input },
        undo: { addToUndoStack, [mode]: { undoStack: [] } },
      }
      const dispose = installUndoBoundaries(
        { vditor: inner, getValue } as any,
        window,
      )
      try {
        // Find's real local handler consumes Enter after this window-capture listener runs.
        find.addEventListener('keydown', (event) => {
          event.preventDefault()
          event.stopPropagation()
        })
        for (const modifiers of [
          {},
          { shiftKey: true },
          { ctrlKey: true, altKey: true },
        ]) {
          find.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Enter',
              bubbles: true,
              cancelable: true,
              ...modifiers,
            }),
          )
          vi.runAllTimers()
          expect(host).toBe(exact)
          expect(input).not.toHaveBeenCalled()
          expect(addToUndoStack).not.toHaveBeenCalled()
          expect(getValue).not.toHaveBeenCalled()
        }
        find.dispatchEvent(new Event('paste', { bubbles: true }))
        vi.runAllTimers()
        expect(host).toBe(exact)
        expect(input).not.toHaveBeenCalled()
        // Widget typing must not dirty the editor's next boundary.
        find.dispatchEvent(new Event('input', { bubbles: true }))
        editor.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        )
        expect(addToUndoStack).not.toHaveBeenCalled()
        vi.runAllTimers()
        expect(input).toHaveBeenCalledOnce()
        expect(addToUndoStack).toHaveBeenCalledOnce()
        editor.dispatchEvent(new Event('paste', { bubbles: true }))
        vi.runAllTimers()
        expect(input).toHaveBeenCalledTimes(2)
        expect(addToUndoStack).toHaveBeenCalledTimes(2)
      } finally {
        dispose()
        vi.useRealTimers()
        document.body.replaceChildren()
      }
    },
  )
})
