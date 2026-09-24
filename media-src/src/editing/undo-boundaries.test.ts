// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  checkpointUndoBoundary,
  installUndoBoundaries,
  isUndoBoundaryCommand,
  isSyntaxPromotionText,
  markToolbarHotkeyKeydownBridged,
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
    [{ key: 'f', ctrlKey: true, shiftKey: true }, true],
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
})
