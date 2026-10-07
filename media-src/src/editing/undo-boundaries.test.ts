// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installCompositionState } from '../util/caret-gesture'
import { logToHost } from '../util/webview-log'
import { installVditorHistoryCoupling } from './undo-keybind'

vi.mock('../util/webview-log', () => ({
  logToHost: vi.fn(),
  reportError: vi.fn(),
}))
import {
  cancelPendingAfterRender,
  checkpointUndoBoundary,
  installUndoBoundaries,
  preparePendingHistory,
  isUndoBoundaryCommand,
  isSyntaxPromotionText,
  seedUndoBaseline,
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

// Task 598 — the first-action seed. The fake engine method mirrors the patched contract (one
// snapshot while the active mode's history is empty); `vditor-source-patches.test.ts` and the
// Chromium harness prove the real method.
describe('first-action undo seed (Task 598)', () => {
  type Mode = 'ir' | 'wysiwyg' | 'sv'

  function setup(mode: Mode = 'ir', withSeed = true) {
    const order: string[] = []
    const makeRoot = (m: Mode) => {
      const root = document.createElement('div')
      root.className = `vditor-${m}`
      root.innerHTML = '<p data-block="0">Alpha bravo</p>'
      document.body.append(root)
      return root
    }
    const roots: Record<Mode, HTMLElement> = {
      ir: makeRoot('ir'),
      wysiwyg: makeRoot('wysiwyg'),
      sv: makeRoot('sv'),
    }
    const toolbar = document.createElement('div')
    toolbar.className = 'vditor-toolbar'
    toolbar.innerHTML = '<button data-type="bold"></button>'
    document.body.append(toolbar)
    const find = document.createElement('div')
    find.className = 'vmde-find-replace'
    find.innerHTML = '<input />'
    document.body.append(find)
    const stacks = {
      ir: { undoStack: [] as unknown[] },
      wysiwyg: { undoStack: [] as unknown[] },
      sv: { undoStack: [] as unknown[] },
    }
    const input = vi.fn(() => order.push('input'))
    const getValue = vi.fn(() => {
      order.push('getValue')
      return 'Alpha bravo\n'
    })
    const inner: any = {
      currentMode: mode,
      options: { undoDelay: 800, input },
      ir: { processTimeoutId: 11, element: roots.ir },
      wysiwyg: { afterRenderTimeoutId: 22, element: roots.wysiwyg },
      sv: { processTimeoutId: 33, element: roots.sv },
      undo: {
        ...stacks,
        addToUndoStack: vi.fn((v: any) => {
          order.push('add')
          v.undo[v.currentMode].undoStack.push('entry')
        }),
      },
    }
    const seed = vi.fn((v: any) => {
      const stack = v.undo[v.currentMode].undoStack
      if (stack.length > 0) {
        order.push('seed:refused')
        return false
      }
      order.push('seed')
      stack.push('seed')
      return true
    })
    if (withSeed) inner.undo.vmdeSeedBaseline = seed
    const dispose = installUndoBoundaries(
      { vditor: inner, getValue } as any,
      window,
    )
    return {
      order,
      roots,
      root: roots[mode],
      toolbar: toolbar.querySelector('button')!,
      find: find.querySelector('input')!,
      inner,
      seed,
      input,
      getValue,
      dispose,
    }
  }

  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  const key = (target: EventTarget, init: KeyboardEventInit) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, ...init }),
    )

  it('delegates to the patched engine method and reports its result', () => {
    const inner: any = { currentMode: 'ir', undo: {} }
    expect(seedUndoBaseline(inner)).toBe(false)
    inner.undo.vmdeSeedBaseline = vi.fn(() => true)
    expect(seedUndoBaseline(inner)).toBe(true)
    expect(inner.undo.vmdeSeedBaseline).toHaveBeenCalledWith(inner, undefined)
    const event = new Event('cut')
    seedUndoBaseline(inner, event)
    expect(inner.undo.vmdeSeedBaseline).toHaveBeenLastCalledWith(inner, event)
    expect(seedUndoBaseline({ currentMode: 'sv' } as any)).toBe(false)
  })

  it('takes no seed while a composition is active', () => {
    const disposeComposition = installCompositionState(document)
    try {
      const inner: any = {
        currentMode: 'ir',
        undo: { vmdeSeedBaseline: vi.fn(() => true) },
      }
      document.dispatchEvent(new CompositionEvent('compositionstart'))
      expect(seedUndoBaseline(inner)).toBe(false)
      expect(inner.undo.vmdeSeedBaseline).not.toHaveBeenCalled()
      document.dispatchEvent(new CompositionEvent('compositionend'))
      expect(seedUndoBaseline(inner)).toBe(true)
    } finally {
      disposeComposition()
    }
  })

  it('is a no-op on an engine without the patched method', () => {
    vi.useFakeTimers()
    const { root, toolbar, order, dispose } = setup('ir', false)
    key(root, { key: 'x' })
    root.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    toolbar.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    vi.runAllTimers()
    // The pre-598 behavior: the after-action checkpoint is the first entry.
    expect(order).toEqual(['add', 'getValue', 'input'])
    dispose()
  })

  it.each(['ir', 'wysiwyg', 'sv'] as const)(
    '%s: a non-modifier keydown seeds the active mode once, publishing nothing',
    (mode) => {
      vi.useFakeTimers()
      const { root, inner, seed, input, getValue, dispose } = setup(mode)
      key(root, { key: 'x' })
      key(root, { key: 'y' })
      vi.runAllTimers()
      expect(seed).toHaveBeenCalledTimes(2)
      expect(seed.mock.results.map((r) => r.value)).toEqual([true, false])
      expect(inner.undo[mode].undoStack).toEqual(['seed'])
      for (const other of (['ir', 'wysiwyg', 'sv'] as const).filter(
        (m) => m !== mode,
      ))
        expect(inner.undo[other].undoStack).toEqual([])
      expect(input).not.toHaveBeenCalled()
      expect(getValue).not.toHaveBeenCalled()
      expect(inner.undo.addToUndoStack).not.toHaveBeenCalled()
      dispose()
    },
  )

  it('passes the keydown to the engine so its own first-position hook can skip it', () => {
    const { root, inner, seed, dispose } = setup()
    const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })
    root.dispatchEvent(event)
    expect(seed).toHaveBeenCalledWith(inner, event)
    dispose()
  })

  it('seeds a forwarded command chord without preventing or stopping it', () => {
    const { root, seed, dispose } = setup()
    const event = new KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    const reached = vi.fn()
    document.body.addEventListener('keydown', reached)
    root.dispatchEvent(event)
    expect(seed).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(false)
    expect(reached).toHaveBeenCalledOnce()
    document.body.removeEventListener('keydown', reached)
    dispose()
  })

  it.each(['Control', 'Meta', 'Alt', 'AltGraph', 'Shift'])(
    'a bare %s keydown takes no seed',
    (name) => {
      const { root, seed, dispose } = setup()
      key(root, { key: name })
      expect(seed).not.toHaveBeenCalled()
      dispose()
    },
  )

  it('excludes the Find widget, composing keys and an active composition', () => {
    const { root, find, seed, dispose } = setup()
    key(find, { key: 'x' })
    find.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    key(root, { key: 'x', isComposing: true })
    root.dispatchEvent(
      new InputEvent('beforeinput', { bubbles: true, isComposing: true }),
    )
    const disposeComposition = installCompositionState(document)
    document.dispatchEvent(new CompositionEvent('compositionstart'))
    key(root, { key: 'x' })
    root.dispatchEvent(new Event('cut', { bubbles: true }))
    disposeComposition()
    expect(seed).not.toHaveBeenCalled()
    dispose()
  })

  it.each(['beforeinput', 'cut', 'drop'])(
    'a %s on the active editor seeds; outside it or on an inactive mode it does not',
    (type) => {
      const { root, roots, find, seed, dispose } = setup('wysiwyg')
      find.parentElement!.dispatchEvent(new Event(type, { bubbles: true }))
      roots.ir.dispatchEvent(new Event(type, { bubbles: true }))
      document.body.dispatchEvent(new Event(type, { bubbles: true }))
      expect(seed).not.toHaveBeenCalled()
      root.querySelector('p')!.dispatchEvent(new Event(type, { bubbles: true }))
      expect(seed).toHaveBeenCalledOnce()
      dispose()
    },
  )

  it('derives the active root at the event, after a mode switch', () => {
    const { roots, inner, seed, dispose } = setup('ir')
    inner.currentMode = 'sv'
    roots.ir.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    expect(seed).not.toHaveBeenCalled()
    roots.sv.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    expect(inner.undo.sv.undoStack).toEqual(['seed'])
    expect(inner.undo.ir.undoStack).toEqual([])
    dispose()
  })

  it('a toolbar action seeds before its after-action checkpoint, which is a second entry', () => {
    vi.useFakeTimers()
    const { toolbar, inner, order, dispose } = setup()
    toolbar.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(order).toEqual(['seed'])
    vi.runAllTimers()
    expect(order).toEqual(['seed', 'add', 'getValue', 'input'])
    expect(inner.undo.ir.undoStack).toEqual(['seed', 'entry'])
    dispose()
  })

  it('a dirty boundary seeds before its forced checkpoint', () => {
    vi.useFakeTimers()
    const { root, toolbar, order, dispose } = setup()
    root.dispatchEvent(new Event('input', { bubbles: true }))
    toolbar.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(order).toEqual(['seed', 'add'])
    vi.runAllTimers()
    // The existing after-action checkpoint follows (the real engine skips an unchanged snapshot).
    expect(order).toEqual(['seed', 'add', 'add', 'getValue', 'input'])
    dispose()
  })

  it('a key plus its command toolbar click takes one seed and one boundary', () => {
    vi.useFakeTimers()
    const { root, toolbar, inner, order, dispose } = setup()
    key(root, { key: 'b', ctrlKey: true })
    toolbar.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    vi.runAllTimers()
    expect(order).toEqual(['seed', 'seed:refused', 'add', 'getValue', 'input'])
    expect(inner.undo.ir.undoStack).toEqual(['seed', 'entry'])
    dispose()
  })

  it('paste seeds through its existing boundary', () => {
    vi.useFakeTimers()
    const { root, order, dispose } = setup()
    root.dispatchEvent(new Event('paste', { bubbles: true }))
    vi.runAllTimers()
    expect(order).toEqual(['seed', 'add', 'getValue', 'input'])
    dispose()
  })

  it('every editor action seeds, whatever key it is bound to; listed ones also take a boundary', () => {
    vi.useFakeTimers()
    const { order, dispose } = setup()
    expect(takeEditorActionUndoBoundary('table-insert-row-above')).toBe(false)
    expect(order).toEqual(['seed'])
    vi.runAllTimers()
    expect(order).toEqual(['seed'])
    const listed = new Set(['table-align-center'] as const)
    expect(takeEditorActionUndoBoundary('table-align-center', listed)).toBe(
      true,
    )
    vi.runAllTimers()
    expect(order).toEqual([
      'seed',
      'seed:refused',
      'seed:refused',
      'add',
      'getValue',
      'input',
    ])
    dispose()
  })

  it('removes every seed listener on disposal', () => {
    const { root, seed, dispose } = setup()
    dispose()
    key(root, { key: 'x' })
    for (const type of ['beforeinput', 'cut', 'drop'])
      root.dispatchEvent(new Event(type, { bubbles: true }))
    takeEditorActionUndoBoundary('table-insert-row-above')
    root.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    )
    expect(seed).not.toHaveBeenCalled()
  })

  it.each([
    ['ir', 11],
    ['wysiwyg', 22],
    ['sv', 33],
  ] as const)(
    '%s: an unseeded composition on an empty history holds its publication timer %d',
    (mode, timer) => {
      const { root, inner, dispose } = setup(mode)
      root.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true }),
      )
      expect(inner.undo.vmdeHeldTimer).toBe(timer)
      dispose()
    },
  )

  it('holds no timer once the history has an entry, or for a composition elsewhere', () => {
    const { root, find, inner, dispose } = setup('ir')
    find.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    )
    expect(inner.undo.vmdeHeldTimer).toBeUndefined()
    inner.undo.ir.undoStack.push('entry')
    root.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    )
    expect(inner.undo.vmdeHeldTimer).toBeUndefined()
    dispose()
  })

  it('treats a mode without a history object as empty, and an older disposal keeps the newer seed', () => {
    const first = setup('ir')
    const second = setup('ir')
    first.dispose()
    takeEditorActionUndoBoundary('table-insert-row-above')
    expect(second.seed).toHaveBeenCalledOnce()
    second.inner.undo.ir = undefined
    second.root.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    )
    expect(second.inner.undo.vmdeHeldTimer).toBe(11)
    second.dispose()
  })

  it('never cancels a timer itself: only the engine method decides', () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    const { root, dispose } = setup()
    key(root, { key: 'x' })
    root.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    expect(clear).not.toHaveBeenCalled()
    clear.mockRestore()
    dispose()
  })
})

// Task 601 — Undo/Redo before the latest edit's checkpoint lands. The fake engine models the
// build-time patch: each mode's after-render timer leaves a single-use record
// (`vmdeAfterRender`) whose `run` is the original callback body.
describe('pending checkpoint before history (Task 601)', () => {
  type Mode = 'ir' | 'wysiwyg' | 'sv'
  type Flags = { enableAddUndoStack: boolean; enableInput: boolean }

  function setup(mode: Mode = 'ir', options: Record<string, unknown> = {}) {
    const order: string[] = []
    const root = document.createElement('div')
    root.innerHTML = '<p data-block="0">Alpha delta.X</p>'
    document.body.append(root)
    const toolbar = document.createElement('div')
    toolbar.className = 'vditor-toolbar'
    const elements: Record<string, HTMLElement> = {}
    for (const name of ['undo', 'redo', 'bold']) {
      const item = document.createElement('div')
      item.innerHTML = `<button data-type="${name}" class="vditor-menu--disabled"><svg><use></use></svg></button>`
      toolbar.append(item)
      elements[name] = item
    }
    document.body.append(toolbar)
    const state = () => inner.undo[inner.currentMode]
    const setDisabled = (name: string, disabled: boolean) =>
      elements[name].children[0].classList.toggle(
        'vditor-menu--disabled',
        disabled,
      )
    const html = () => root.innerHTML
    const inner: any = {
      currentMode: mode,
      options: {
        undoDelay: 800,
        input: vi.fn(() => order.push('input')),
      },
      toolbar: { elements },
      ir: { processTimeoutId: undefined, element: root },
      wysiwyg: { afterRenderTimeoutId: undefined, element: root },
      sv: { processTimeoutId: undefined, element: root },
      undo: {
        ir: { undoStack: ['seed', 'X'], redoStack: [], lastText: '' },
        wysiwyg: { undoStack: ['seed', 'X'], redoStack: [], lastText: '' },
        sv: { undoStack: ['seed', 'X'], redoStack: [], lastText: '' },
        addToUndoStack: vi.fn(() => {
          order.push('add')
          state().undoStack.push('entry')
          state().lastText = `${html()}<wbr>`
          state().redoStack = []
          setDisabled('undo', state().undoStack.length < 2)
        }),
        undo: vi.fn(() => {
          order.push('undo')
          if (state().undoStack.length < 2) return
          state().redoStack.push(state().undoStack.pop())
          setDisabled('redo', false)
          // The restored source: the last character goes away.
          const paragraph = root.querySelector('p')!
          paragraph.textContent = paragraph.textContent!.slice(0, -1)
        }),
        redo: vi.fn(() => {
          order.push('redo')
          const entry = state().redoStack.pop()
          if (entry) state().undoStack.push(entry)
        }),
      },
    }
    for (const m of ['ir', 'wysiwyg', 'sv'] as const)
      inner.undo[m].lastText = `${html()}<wbr>`
    setDisabled('undo', false)
    // Vditor's toolbar Undo/Redo: the disabled check runs before the single engine call.
    for (const name of ['undo', 'redo'] as const)
      elements[name].children[0].addEventListener('click', (event) => {
        event.preventDefault()
        if (
          elements[name].children[0].classList.contains('vditor-menu--disabled')
        )
          return
        inner.undo[name](inner)
      })
    const timerKey =
      mode === 'wysiwyg' ? 'afterRenderTimeoutId' : 'processTimeoutId'
    // The patched callback: arm a single-use record and its timer, as the build patch does.
    const arm = (
      flags: Flags = { enableAddUndoStack: true, enableInput: true },
      edit = 'W',
    ) => {
      if (edit) root.querySelector('p')!.append(edit)
      const owner = inner[mode]
      clearTimeout(owner[timerKey])
      const record: any = {
        options: flags,
        run: () => {
          if (owner.vmdeAfterRender === record)
            owner.vmdeAfterRender = undefined
          order.push('run')
          if (flags.enableInput) inner.options.input()
          if (flags.enableAddUndoStack) inner.undo.addToUndoStack(inner)
        },
      }
      record.timer = setTimeout(record.run, 800)
      owner.vmdeAfterRender = record
      owner[timerKey] = record.timer
      return record
    }
    const flushHistoryInput = vi.fn(() => {
      order.push('flush')
      return true
    })
    const getValue = vi.fn(() => root.textContent ?? '')
    const dispose = installUndoBoundaries(
      { vditor: inner, getValue } as any,
      window,
      {
        flushHistoryInput,
        ...options,
      } as any,
    )
    return {
      order,
      root,
      inner,
      elements,
      arm,
      flushHistoryInput,
      getValue,
      dispose,
      button: (name: string) => elements[name].children[0] as HTMLElement,
    }
  }

  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it.each(['ir', 'wysiwyg', 'sv'] as const)(
    '%s: a toolbar Undo click drains the pending checkpoint before the disabled check',
    (mode) => {
      vi.useFakeTimers()
      const { order, inner, arm, button, dispose } = setup(mode)
      // A first edit on the seeded baseline: one entry, so the button is disabled.
      inner.undo[mode].undoStack = ['seed']
      button('undo').classList.add('vditor-menu--disabled')
      arm()
      button('undo')
        .querySelector('use')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(order).toEqual(['run', 'input', 'add', 'flush', 'undo'])
      expect(inner.undo[mode].undoStack).toEqual(['seed'])
      expect(inner.undo[mode].redoStack).toEqual(['entry'])
      vi.runAllTimers()
      expect(order).toEqual(['run', 'input', 'add', 'flush', 'undo'])
      dispose()
    },
  )

  // The shared engine route (keyboard, command): the wrapper prepares before reading `before`.
  function couple(t: ReturnType<typeof setup>) {
    const post = vi.fn((message: { kind: string }) =>
      t.order.push(`post:${message.kind}`),
    )
    installVditorHistoryCoupling(
      { vditor: { vditor: t.inner, getValue: t.getValue } },
      post,
      preparePendingHistory,
    )
    return post
  }

  it.each(['ir', 'wysiwyg', 'sv'] as const)(
    '%s: the engine route drains the pending checkpoint and posts the edit before the transition',
    (mode) => {
      vi.useFakeTimers()
      const t = setup(mode)
      const post = couple(t)
      t.arm()
      t.inner.undo.undo(t.inner)
      expect(t.order).toEqual([
        'run',
        'input',
        'add',
        'flush',
        'undo',
        'post:undo',
      ])
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ before: 'Alpha delta.XW' }),
      )
      expect(t.inner[mode].vmdeAfterRender).toBeUndefined()
      vi.runAllTimers()
      expect(t.order.filter((step) => step === 'run')).toHaveLength(1)
      t.dispose()
    },
  )

  it('runs the IR deferred re-spin first, and only in IR', () => {
    for (const mode of ['ir', 'sv'] as const) {
      const flushRespin = vi.fn(() => {
        t.order.push('respin')
        t.arm()
        return true
      })
      const t = setup(mode, { flushRespin })
      couple(t)
      t.inner.undo.undo(t.inner)
      if (mode === 'ir') {
        expect(flushRespin).toHaveBeenCalledWith(t.inner)
        expect(t.order.slice(0, 3)).toEqual(['respin', 'run', 'input'])
      } else {
        expect(flushRespin).not.toHaveBeenCalled()
        expect(t.order).toEqual(['flush', 'undo', 'post:undo'])
      }
      t.dispose()
      document.body.replaceChildren()
    }
  })

  it('drains nothing on a settled history, so Redo keeps its branch', () => {
    vi.useFakeTimers()
    const t = setup('ir')
    couple(t)
    t.inner.undo.ir.redoStack = ['W']
    t.flushHistoryInput.mockImplementation(() => {
      t.order.push('flush')
      return false
    })
    t.inner.undo.redo(t.inner)
    expect(t.order).toEqual(['flush', 'redo'])
    expect(t.inner.undo.addToUndoStack).not.toHaveBeenCalled()
    t.dispose()
  })

  it.each([
    [{ enableAddUndoStack: false, enableInput: true }, 'a history render'],
    [
      { enableAddUndoStack: true, enableInput: false },
      'a setValue or mode render',
    ],
  ])('leaves %j (%s) to its timer', (flags) => {
    vi.useFakeTimers()
    const t = setup('wysiwyg')
    couple(t)
    const record = t.arm(flags)
    t.inner.undo.undo(t.inner)
    expect(t.order).toEqual(['flush', 'undo', 'post:undo'])
    expect(t.inner.wysiwyg.vmdeAfterRender).toBe(record)
    vi.runAllTimers()
    expect(t.order).toContain('run')
    t.dispose()
  })

  it('leaves a source-neutral pending callback alone: no caret-only entry, Redo kept', () => {
    vi.useFakeTimers()
    const t = setup('ir')
    couple(t)
    t.inner.undo.ir.redoStack = ['W']
    // The checkpoint HTML carries the caret marker and IR's expansion class; the live DOM does not.
    t.inner.undo.ir.lastText =
      '<p data-block="0" class="vditor-ir__node vditor-ir__node--expand">Alpha delta.X<wbr></p>'
    t.root.innerHTML =
      '<p data-block="0" class="vditor-ir__node">Alpha delta.X</p>'
    t.arm(undefined, '')
    t.inner.undo.redo(t.inner)
    expect(t.order).toEqual(['flush', 'redo'])
    expect(t.inner.undo.ir.undoStack).toEqual(['seed', 'X', 'W'])
    t.dispose()
  })

  it('does nothing for another editor or after disposal', () => {
    const t = setup('ir')
    t.arm()
    expect(preparePendingHistory({ ...t.inner })).toBe(true)
    expect(t.order).toEqual([])
    t.dispose()
    expect(preparePendingHistory(t.inner)).toBe(true)
    expect(t.order).toEqual([])
    expect(t.inner.ir.vmdeAfterRender).toBeDefined()
  })

  // The handoff's composition rule: an Undo/Redo during IME composition is refused outright (no
  // drain, no publication, no engine call, no transition) on every route, and logged.
  it.each(['engine', 'toolbar'] as const)(
    'refuses the %s history route during IME composition',
    (route) => {
      vi.mocked(logToHost).mockClear()
      const disposeComposition = installCompositionState(document)
      try {
        const t = setup('ir')
        const post = couple(t)
        t.arm()
        document.dispatchEvent(new CompositionEvent('compositionstart'))
        if (route === 'engine') t.inner.undo.undo(t.inner)
        else t.button('undo').click()
        expect(t.order).toEqual([])
        // No engine call either: the fake engine would have logged 'undo'.
        expect(post).not.toHaveBeenCalled()
        expect(logToHost).toHaveBeenCalledWith(
          expect.stringContaining('composition'),
        )
        document.dispatchEvent(new CompositionEvent('compositionend'))
        t.inner.undo.undo(t.inner)
        expect(t.order.slice(0, 5)).toEqual([
          'run',
          'input',
          'add',
          'flush',
          'undo',
        ])
        t.dispose()
      } finally {
        disposeComposition()
      }
    },
  )

  it('reports a failing callback and still publishes, so the history call proceeds', () => {
    const t = setup('ir')
    const post = couple(t)
    const record = t.arm()
    record.run = () => {
      t.order.push('run')
      throw new Error('render failed')
    }
    t.inner.undo.undo(t.inner)
    expect(t.order).toEqual(['run', 'flush', 'undo', 'post:undo'])
    expect(post).toHaveBeenCalledOnce()
    t.dispose()
  })

  it('a toolbar capture and the engine wrapper drain once between them', () => {
    vi.useFakeTimers()
    const t = setup('sv')
    couple(t)
    t.arm()
    t.button('undo').click()
    expect(t.order.filter((step) => step === 'run')).toHaveLength(1)
    expect(t.order.filter((step) => step === 'flush')).toHaveLength(2)
    expect(t.order.filter((step) => step === 'undo')).toHaveLength(1)
    // An unrelated toolbar button prepares nothing.
    t.order.length = 0
    t.arm()
    t.button('bold').click()
    expect(t.order).toEqual([])
    t.dispose()
  })

  it.each(['ir', 'wysiwyg', 'sv'] as const)(
    '%s: cancelling the pending callback retires its record, so a later Undo cannot drain it',
    (mode) => {
      vi.useFakeTimers()
      const t = setup(mode)
      couple(t)
      t.arm()
      cancelPendingAfterRender(t.inner)
      expect(t.inner[mode].vmdeAfterRender).toBeUndefined()
      t.inner.undo.undo(t.inner)
      vi.runAllTimers()
      expect(t.order).toEqual(['flush', 'undo', 'post:undo'])
      // A forced boundary retires it as well.
      t.arm()
      checkpointUndoBoundary(t.inner, true)
      expect(t.inner[mode].vmdeAfterRender).toBeUndefined()
      t.dispose()
    },
  )

  it('drains when no checkpoint text exists to compare, and ignores a click without a node target', () => {
    vi.useFakeTimers()
    const t = setup('wysiwyg')
    couple(t)
    t.inner.undo.wysiwyg.lastText = undefined
    t.arm()
    window.dispatchEvent(new MouseEvent('click'))
    expect(t.order).toEqual([])
    t.inner.undo.undo(t.inner)
    expect(t.order.slice(0, 3)).toEqual(['run', 'input', 'add'])
    t.dispose()
  })
})
