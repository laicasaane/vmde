// @vitest-environment jsdom

import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  nativeEditingDefaultToBlock,
  setupFormatHotkeyGuard,
} from './format-hotkey-guard'

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
