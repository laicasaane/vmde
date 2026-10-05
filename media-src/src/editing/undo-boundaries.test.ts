// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  checkpointUndoBoundary,
  installUndoBoundaries,
  isUndoBoundaryCommand,
  isSyntaxPromotionText,
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

  // Task 580 CP3-1 — only macOS Cocoa's native Ctrl edits (Ctrl+D/H/K) keep a keydown boundary;
  // every former model-command letter now takes its boundary from its command.
  it.each([
    [{ key: 'd', ctrlKey: true }, true, true],
    [{ key: 'h', ctrlKey: true }, true, true],
    [{ key: 'k', ctrlKey: true }, true, true],
    [{ key: 'K', ctrlKey: true }, true, true],
    [{ key: 'b', ctrlKey: true }, true, false],
    [{ key: 'e', ctrlKey: true }, true, false],
    [{ key: 'm', ctrlKey: true }, true, false],
    [{ key: 'd', metaKey: true }, true, false],
    [{ key: 'h', metaKey: true }, true, false],
    [{ key: 'd', ctrlKey: true, metaKey: true }, true, false],
    [{ key: 'd', ctrlKey: true, shiftKey: true }, true, false],
    [{ key: 'k', ctrlKey: true, altKey: true }, true, false],
    ...['b', 'i', 'd', 'h', 'l', 'e', 'k', 'm', 'u'].map(
      (key) => [{ key, ctrlKey: true }, false, false] as const,
    ),
    [{ key: '=', ctrlKey: true }, false, false],
    [{ key: 'C', ctrlKey: true, shiftKey: true }, false, false],
    [{ key: '1', ctrlKey: true, altKey: true }, false, false],
    [{ key: 'z', ctrlKey: true }, false, false],
    [{ key: 'y', ctrlKey: true }, false, false],
  ] as const)(
    'classifies %j (macOS %s) as a keydown boundary: %s',
    (partial, mac, expected) => {
      const event = new KeyboardEvent('keydown', partial)
      expect(isUndoBoundaryCommand(event, mac)).toBe(expected)
    },
  )

  // Task 580 CP2-2 — the dispatcher's boundary hook. Each conversion step listed its action when it
  // removed the action's key from the keydown boundary list.
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
      expect(takeEditorActionUndoBoundary('table-insert-row-above')).toBe(false)
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

    // Task 580 CP2-9 — the table actions whose former chord took a key boundary take it as an
    // action boundary; Insert Row Above (Shift+F) and the four moves never took one.
    it.each([
      ['table-align-left', true],
      ['table-align-center', true],
      ['table-align-right', true],
      ['table-insert-row-below', true],
      ['table-insert-column-left', true],
      ['table-insert-column-right', true],
      ['table-delete-row', true],
      ['table-delete-column', true],
      ['table-insert-row-above', false],
      ['table-move-column-left', false],
      ['table-move-column-right', false],
      ['table-move-row-up', false],
      ['table-move-row-down', false],
    ] as const)('%s takes an action boundary: %s', (action, expected) => {
      vi.useFakeTimers()
      const { addToUndoStack, dispose } = installWithStack()
      expect(takeEditorActionUndoBoundary(action)).toBe(expected)
      vi.runAllTimers()
      expect(addToUndoStack).toHaveBeenCalledTimes(expected ? 1 : 0)
      dispose()
      vi.useRealTimers()
    })

    // Task 580 CP2-10 — the synthetic table chords (CP2-9) and the heading, edit-mode and task
    // chords take no key boundary; the table actions take theirs from the dispatcher.
    it.each([
      { key: '=', ctrlKey: true },
      { key: '-', ctrlKey: true },
      { key: '+', ctrlKey: true, shiftKey: true },
      { key: '_', ctrlKey: true, shiftKey: true },
      { key: '=', metaKey: true, shiftKey: true },
      { key: 'l', ctrlKey: true, shiftKey: true },
      { key: 'c', ctrlKey: true, shiftKey: true },
      { key: 'r', ctrlKey: true, shiftKey: true },
      { key: 'f', ctrlKey: true, shiftKey: true },
      { key: 'g', ctrlKey: true, shiftKey: true },
      { key: '5', code: 'Digit5', ctrlKey: true, altKey: true },
      { key: '8', code: 'Digit8', metaKey: true, altKey: true },
      { key: 'J', code: 'KeyJ', ctrlKey: true, shiftKey: true },
    ])('the synthetic Vditor chord %j takes no key boundary', (init) => {
      vi.useFakeTimers()
      const { addToUndoStack, input, dispose } = installWithStack()
      window.dispatchEvent(new KeyboardEvent('keydown', init))
      vi.runAllTimers()
      expect(addToUndoStack).not.toHaveBeenCalled()
      expect(input).not.toHaveBeenCalled()
      dispose()
      vi.useRealTimers()
    })

    // Task 580 CP3-1 — the freed formatting defaults and the other former model letters take no
    // keydown boundary on Windows/Linux (jsdom reports a non-Mac platform).
    it.each(['b', 'i', 'd', 'h', 'l', 'e', 'k', 'm', 'u', 'g', ';'])(
      'Ctrl+%s takes no keydown boundary on Windows/Linux',
      (key) => {
        vi.useFakeTimers()
        const { addToUndoStack, input, dispose } = installWithStack()
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key, ctrlKey: true }),
        )
        vi.runAllTimers()
        expect(addToUndoStack).not.toHaveBeenCalled()
        expect(input).not.toHaveBeenCalled()
        dispose()
        vi.useRealTimers()
      },
    )
  })

  // Task 580 CP3-1 — P5 CP1-3b1: one Undo step per Bold. The command's keydown takes no boundary
  // and its toolbar click takes exactly one.
  it('takes one boundary for a formatting key press plus its command toolbar click', () => {
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

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }),
    )
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

  // Task 580 CP4-1 — Ctrl/Meta/Alt+Enter is no editing key any more (the former link/callout
  // activation chord is unbound, and Ctrl+Alt+Enter is Replace All). Its boundary posted
  // input(getValue()) and rewrote exact host bytes with Vditor's serialization; plain Enter and
  // Shift+Enter still split blocks and lines, so they keep theirs.
  it.each([
    ['Enter', 1, {}],
    ['Shift+Enter', 1, { shiftKey: true }],
    ['Ctrl+Enter', 0, { ctrlKey: true }],
    ['Meta+Enter', 0, { metaKey: true }],
    ['Alt+Enter', 0, { altKey: true }],
    ['Ctrl+Alt+Enter', 0, { ctrlKey: true, altKey: true }],
    ['Ctrl+Shift+Enter', 0, { ctrlKey: true, shiftKey: true }],
  ] as const)('%s takes %i editor boundary', (_name, expected, modifiers) => {
    vi.useFakeTimers()
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    document.body.append(editor)
    const input = vi.fn()
    const addToUndoStack = vi.fn()
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
    try {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          ...modifiers,
        }),
      )
      vi.runAllTimers()
      expect(input).toHaveBeenCalledTimes(expected)
      expect(addToUndoStack).toHaveBeenCalledTimes(expected)
    } finally {
      dispose()
      vi.useRealTimers()
      document.body.replaceChildren()
    }
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
