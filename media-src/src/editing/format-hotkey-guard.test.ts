// @vitest-environment jsdom

import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  liveCaretIntentForTests,
  requestCaret,
  resetCaretAuthorityForTests,
  setCaretPaintabilityProbeForTests,
} from './caret'
import {
  nativeEditingDefaultToBlock,
  restoreCommandSelection,
  setupFormatHotkeyGuard,
} from './format-hotkey-guard'
import { buildUndoRedoMatcher, type UndoRedoMatcher } from './undo-redo-keys'

const ev = (o: Partial<KeyboardEvent>) =>
  ({
    key: 'b',
    keyCode: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    ...o,
  }) as KeyboardEvent

describe('nativeEditingDefaultToBlock (Task 580 policy 7)', () => {
  function surfaceWithInput() {
    document.body.innerHTML =
      '<div id="surface" contenteditable="true"><p>Hello</p></div><input id="find">'
    return {
      surface: document.getElementById('surface') as HTMLElement,
      paragraph: document.querySelector('p') as HTMLElement,
      input: document.getElementById('find') as HTMLInputElement,
    }
  }

  it.each(['b', 'i', 'u'])(
    'blocks Ctrl+%s on Win/Linux and Cmd+%s on macOS',
    (key) => {
      expect(
        nativeEditingDefaultToBlock(ev({ key, ctrlKey: true }), false, null),
      ).toBe(true)
      expect(
        nativeEditingDefaultToBlock(ev({ key, metaKey: true }), true, null),
      ).toBe(true)
    },
  )

  it('matches B/I/U by key code when the layout key is not Latin', () => {
    expect(
      nativeEditingDefaultToBlock(
        ev({ key: 'и', keyCode: 66, ctrlKey: true }),
        false,
        null,
      ),
    ).toBe(true)
  })

  it.each([
    [
      'Ctrl+Shift+U (Linux IME Unicode entry, left as P3 recorded)',
      { key: 'U', ctrlKey: true, shiftKey: true },
      false,
    ],
    ['Ctrl+Alt+B', { key: 'b', ctrlKey: true, altKey: true }, false],
    ['plain B', { key: 'b' }, false],
    ['Ctrl+D', { key: 'd', ctrlKey: true }, false],
  ] as const)('leaves %s to the browser', (_name, init, mac) => {
    expect(nativeEditingDefaultToBlock(ev(init), mac, null)).toBe(false)
  })

  it('leaves macOS Ctrl+B (Cocoa move-backward) to the browser', () => {
    expect(
      nativeEditingDefaultToBlock(ev({ key: 'b', ctrlKey: true }), true, null),
    ).toBe(false)
  })

  // Task 580 CP2-6 turned the select-all half on with `vmde.selectAll`.
  it('blocks select-all by default and leaves it when the option turns it off', () => {
    const { surface } = surfaceWithInput()
    const onSurface = ev({ key: 'a', ctrlKey: true, target: surface })
    expect(nativeEditingDefaultToBlock(onSurface, false, surface)).toBe(true)
    expect(
      nativeEditingDefaultToBlock(
        ev({ ...onSurface, ctrlKey: false, metaKey: true }),
        true,
        surface,
      ),
    ).toBe(true)
    expect(
      nativeEditingDefaultToBlock(onSurface, false, surface, {
        selectAll: false,
      }),
    ).toBe(false)
  })

  it('blocks select-all only when the key targets the active editing surface', () => {
    const { surface, paragraph, input } = surfaceWithInput()
    const selectAll = (target: EventTarget | null) =>
      nativeEditingDefaultToBlock(
        ev({ key: 'a', ctrlKey: true, target }),
        false,
        surface,
      )

    expect(selectAll(surface)).toBe(true)
    expect(selectAll(paragraph)).toBe(true)
    expect(selectAll(input)).toBe(false)
    expect(selectAll(document.body)).toBe(false)
    expect(
      nativeEditingDefaultToBlock(
        ev({ key: 'a', ctrlKey: true, target: paragraph }),
        false,
        null,
      ),
    ).toBe(false)
    expect(
      nativeEditingDefaultToBlock(
        ev({ key: 'a', ctrlKey: true, shiftKey: true, target: paragraph }),
        false,
        surface,
      ),
    ).toBe(false)
  })
})

// The keydown listener. It reads no keybinding (Task 580 CP3-1 removed the last default-key
// match), so a bound, unbound or remapped command gets the same native guard.
describe('setupFormatHotkeyGuard', () => {
  afterEach(() => {
    document.body.replaceChildren()
    ;(window as any).vditor = undefined
  })

  function installGuard() {
    document.body.innerHTML =
      '<div id="surface" contenteditable="true"><p>Hello</p></div><input id="find">'
    const surface = document.getElementById('surface') as HTMLElement
    ;(window as any).vditor = {
      vditor: { currentMode: 'ir', ir: { element: surface } },
    }
    const listeners = new Map<
      string,
      { fn: (e: any) => void; capture: unknown }
    >()
    const win = {
      navigator: { platform: 'Linux x86_64' },
      document,
      getSelection: () => document.getSelection(),
      get vditor() {
        return (window as any).vditor
      },
      addEventListener: (type: string, fn: any, capture: unknown) =>
        listeners.set(type, { fn, capture }),
      removeEventListener: vi.fn(),
    }
    setupFormatHotkeyGuard(win as unknown as Window & typeof globalThis)
    const press = (init: Partial<KeyboardEvent>) => {
      const event = {
        ...ev({ target: surface.firstElementChild }),
        isTrusted: true,
        isComposing: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        stopImmediatePropagation: vi.fn(),
        ...init,
      }
      listeners.get('keydown')?.fn(event)
      return event
    }
    return { press, listeners, surface }
  }

  // Task 664 (acceptance 3, a real transparent site): putting the chord's selection back must leave
  // a live caret intent armed, so Vditor churn stays overridden.
  it('restoreCommandSelection puts the selection back and leaves a live caret intent armed', () => {
    const { press, surface } = installGuard()
    setCaretPaintabilityProbeForTests(() => true)
    try {
      const text = surface.firstElementChild!.firstChild as Text
      const selection = window.getSelection()!
      selection.setBaseAndExtent(text, 1, text, 4)
      press({ key: 'b', ctrlKey: true })
      requestCaret({ node: text, offset: 0 })
      selection.setBaseAndExtent(text, 5, text, 5)
      expect(restoreCommandSelection(window, { focusEditor: false })).toBe(true)
      expect([selection.anchorOffset, selection.focusOffset]).toEqual([1, 4])
      expect(liveCaretIntentForTests()).toEqual({ node: text, offset: 0 })
    } finally {
      resetCaretAuthorityForTests()
    }
  })

  it('blocks trusted Ctrl+B/I/U and never stops propagation', () => {
    const { press, listeners } = installGuard()
    expect(listeners.get('keydown')?.capture).toBe(true)
    for (const key of ['b', 'i', 'u']) {
      const event = press({ key, ctrlKey: true })
      expect(event.preventDefault).toHaveBeenCalled()
      expect(event.stopPropagation).not.toHaveBeenCalled()
      expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
    }
  })

  it('blocks native select-all on the surface but not in an input', () => {
    const { press } = installGuard()
    const onSurface = press({ key: 'a', ctrlKey: true })
    expect(onSurface.preventDefault).toHaveBeenCalled()
    expect(onSurface.stopPropagation).not.toHaveBeenCalled()
    expect(onSurface.stopImmediatePropagation).not.toHaveBeenCalled()
    expect(
      press({
        key: 'a',
        ctrlKey: true,
        target: document.getElementById('find'),
      }).preventDefault,
    ).not.toHaveBeenCalled()
  })

  // The freed formatting defaults and the still-bound Indent/Outdent keys have no native editing
  // command, so the guard leaves them to the browser and to VS Code.
  it.each([
    { key: 'd', ctrlKey: true },
    { key: 'l', ctrlKey: true },
    { key: 'g', ctrlKey: true },
    { key: ';', ctrlKey: true },
    { key: '7', ctrlKey: true, shiftKey: true },
    { key: '9', ctrlKey: true, shiftKey: true },
    { key: '[', ctrlKey: true },
    { key: ']', ctrlKey: true },
  ])('leaves %j unprevented', (init) => {
    const { press } = installGuard()
    expect(press(init).preventDefault).not.toHaveBeenCalled()
  })

  it('leaves an untrusted Ctrl+B alone (it cannot run a native command)', () => {
    const { press } = installGuard()
    expect(
      press({ key: 'b', ctrlKey: true, isTrusted: false }).preventDefault,
    ).not.toHaveBeenCalled()
  })

  it('takes no action while an IME composition is active', () => {
    const { press } = installGuard()
    expect(
      press({ key: 'b', ctrlKey: true, isComposing: true }).preventDefault,
    ).not.toHaveBeenCalled()
  })
})

// Task 733 / 036 D-18: the IR editor owns its Undo/Redo chords at keydown.
describe('setupFormatHotkeyGuard: IR-owned Undo/Redo keys', () => {
  afterEach(() => {
    document.body.replaceChildren()
    ;(window as any).vditor = undefined
  })

  function installOwned(
    options: {
      mode?: string
      owns?: boolean
      ready?: boolean
      field?: unknown
      matcher?: UndoRedoMatcher
    } = {},
  ) {
    document.body.innerHTML =
      '<div id="surface" contenteditable="true"><p>Hello</p><div contenteditable="false"><span id="island">x</span></div><div class="vditor-hint"><b id="hint">h</b></div></div><input id="find">'
    const surface = document.getElementById('surface') as HTMLElement
    const paragraph = surface.firstElementChild as HTMLElement
    surface.focus()
    ;(window as any).vditor = {
      vditor: { currentMode: options.mode ?? 'ir', ir: { element: surface } },
    }
    const listeners = new Map<string, (e: any) => void>()
    const win = {
      navigator: { platform: 'Linux x86_64' },
      document,
      getSelection: () => document.getSelection(),
      get vditor() {
        return (window as any).vditor
      },
      addEventListener: (type: string, fn: any) => listeners.set(type, fn),
      removeEventListener: vi.fn(),
    }
    const calls: string[] = []
    const owned = {
      matcher: () =>
        options.matcher ?? buildUndoRedoMatcher(undefined, 'linux'),
      viewReady: () => options.ready ?? true,
      ownsHistoryNow: () => options.owns ?? true,
      focusedField: () => options.field ?? null,
      cancelAutoWrap: () => calls.push('cancelAutoWrap'),
      run: (kind: string) => calls.push(`run:${kind}`),
      noteInput: () => calls.push('noteInput'),
    }
    const teardown = setupFormatHotkeyGuard(
      win as unknown as Window & typeof globalThis,
      owned,
    )
    const fire = (type: string, init: Partial<KeyboardEvent>) => {
      const event = {
        ...ev({ target: paragraph }),
        code: '',
        isTrusted: true,
        isComposing: false,
        preventDefault: vi.fn(() => calls.push('preventDefault')),
        stopPropagation: vi.fn(),
        stopImmediatePropagation: vi.fn(() => calls.push('stop')),
        ...init,
      }
      listeners.get(type)?.(event)
      return event
    }
    const press = (init: Partial<KeyboardEvent>) => fire('keydown', init)
    return { press, fire, calls, listeners, teardown, surface }
  }

  const ctrlZ = { key: 'z', code: 'KeyZ', ctrlKey: true }

  it('consumes the chord, cancels auto-wrap once, then runs one move', () => {
    const { press, calls } = installOwned()
    press(ctrlZ)
    expect(calls).toEqual([
      // 036 core C3 (L1): the input is noted first, before the owned move.
      'noteInput',
      'preventDefault',
      'stop',
      'cancelAutoWrap',
      'run:undo',
    ])
  })

  it('runs Redo for Ctrl+Shift+Z and Ctrl+Y, and one move per repeated keydown', () => {
    const { press, calls } = installOwned()
    press({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true })
    press({ key: 'y', code: 'KeyY', ctrlKey: true, repeat: true })
    press({ key: 'y', code: 'KeyY', ctrlKey: true, repeat: true })
    expect(calls.filter((c) => c.startsWith('run:'))).toEqual([
      'run:redo',
      'run:redo',
      'run:redo',
    ])
  })

  it.each([
    ['untrusted', { isTrusted: false }, {}],
    ['composing', { isComposing: true }, {}],
    ['keyCode 229', { keyCode: 229 }, {}],
    ['outside IR', {}, { mode: 'wysiwyg' }],
    ['history not owned', {}, { owns: false }],
    ['view not ready', {}, { ready: false }],
    ['a VMDE field focused', {}, { field: {} }],
    [
      'ownership switched off',
      {},
      { matcher: buildUndoRedoMatcher({ inEditor: false }, 'linux') },
    ],
  ])('leaves the chord to VS Code when %s', (_name, init, options) => {
    const { press, calls } = installOwned(options)
    const event = press({ ...ctrlZ, ...init })
    expect(calls.filter((c) => c.startsWith('run:'))).toEqual([])
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
  })

  it.each(['island', 'hint', 'find'])(
    'leaves the chord to VS Code for a target in #%s',
    (id) => {
      const { press, calls } = installOwned()
      press({ ...ctrlZ, target: document.getElementById(id) })
      expect(calls.filter((c) => c.startsWith('run:'))).toEqual([])
    },
  )

  it('an unowned modifier chord still reaches the native-format guard and the selection snapshot', () => {
    const { press, calls } = installOwned({ owns: false })
    const bold = press({ key: 'b', code: 'KeyB', ctrlKey: true })
    expect(bold.preventDefault).toHaveBeenCalled()
    expect(bold.stopImmediatePropagation).not.toHaveBeenCalled()
    // 036 core C3 (L1): every trusted keydown is noted first.
    expect(calls).toEqual(['noteInput', 'preventDefault'])
  })

  it('suppresses the release of an owned Backspace chord, even after Alt came up first', () => {
    const matcher = buildUndoRedoMatcher({ undo: ['alt+backspace'] }, 'linux')
    const { press, fire, calls } = installOwned({ matcher })
    press({ key: 'Backspace', code: 'Backspace', altKey: true })
    expect(calls).toContain('run:undo')
    const altUp = fire('keyup', { key: 'Alt', code: 'AltLeft' })
    expect(altUp.stopImmediatePropagation).not.toHaveBeenCalled()
    const release = fire('keyup', { key: 'Backspace', code: 'Backspace' })
    expect(release.preventDefault).toHaveBeenCalled()
    expect(release.stopImmediatePropagation).toHaveBeenCalled()
    const next = fire('keyup', { key: 'Backspace', code: 'Backspace' })
    expect(next.stopImmediatePropagation).not.toHaveBeenCalled()
  })

  it('does not suppress the release of a letter chord', () => {
    const { press, fire } = installOwned()
    press(ctrlZ)
    expect(
      fire('keyup', { key: 'z', code: 'KeyZ' }).stopImmediatePropagation,
    ).not.toHaveBeenCalled()
  })

  it('clears the release tracking on blur and on teardown', () => {
    const matcher = buildUndoRedoMatcher({ undo: ['alt+delete'] }, 'linux')
    const first = installOwned({ matcher })
    first.press({ key: 'Delete', code: 'Delete', altKey: true })
    first.listeners.get('blur')?.({})
    expect(
      first.fire('keyup', { key: 'Delete', code: 'Delete' })
        .stopImmediatePropagation,
    ).not.toHaveBeenCalled()
    first.press({ key: 'Delete', code: 'Delete', altKey: true })
    first.teardown()
    expect(
      first.fire('keyup', { key: 'Delete', code: 'Delete' })
        .stopImmediatePropagation,
    ).not.toHaveBeenCalled()
  })
})

// 036 core C3 (L1): the guard notes every trusted keydown, pointerdown and beforeinput for the replay.
describe('setupFormatHotkeyGuard: replay input notification', () => {
  function install() {
    const listeners = new Map<string, (e: any) => void>()
    const win = {
      navigator: { platform: 'Linux x86_64' },
      document,
      getSelection: () => document.getSelection(),
      vditor: undefined,
      addEventListener: (type: string, fn: any) => listeners.set(type, fn),
      removeEventListener: vi.fn(),
    }
    const noteInput = vi.fn()
    setupFormatHotkeyGuard(win as unknown as Window & typeof globalThis, {
      matcher: () => buildUndoRedoMatcher(undefined, 'linux'),
      viewReady: () => true,
      ownsHistoryNow: () => false,
      focusedField: () => null,
      cancelAutoWrap: vi.fn(),
      run: vi.fn(),
      noteInput,
    })
    const fire = (type: string, isTrusted: boolean) =>
      listeners.get(type)?.({
        type,
        key: 'a',
        code: 'KeyA',
        isTrusted,
        isComposing: false,
        target: document.body,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        stopImmediatePropagation: vi.fn(),
      })
    return { fire, noteInput }
  }

  it('notes trusted keydown, pointerdown and beforeinput, never untrusted ones', () => {
    const { fire, noteInput } = install()
    for (const type of ['keydown', 'pointerdown', 'beforeinput'])
      fire(type, false)
    expect(noteInput).not.toHaveBeenCalled()
    for (const type of ['keydown', 'pointerdown', 'beforeinput'])
      fire(type, true)
    expect(noteInput).toHaveBeenCalledTimes(3)
  })
})
