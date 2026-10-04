// @vitest-environment jsdom

import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  isPromotedFormatHotkey,
  nativeEditingDefaultToBlock,
  normalizeEventKey,
} from './format-hotkey-guard'
import type { FormatHotkey } from '../../../src/shared/format-hotkeys'

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

describe('normalizeEventKey', () => {
  it('normalizes Ctrl+B (non-mac) to "ctrl+b"', () => {
    expect(normalizeEventKey(ev({ key: 'b', ctrlKey: true }), false)).toBe(
      'ctrl+b',
    )
  })
  it('normalizes Cmd+B (mac) to "cmd+b"', () => {
    expect(normalizeEventKey(ev({ key: 'b', metaKey: true }), true)).toBe(
      'cmd+b',
    )
  })
  it('includes shift: Ctrl+Shift+7 -> "ctrl+shift+7"', () => {
    expect(
      normalizeEventKey(ev({ key: '7', ctrlKey: true, shiftKey: true }), false),
    ).toBe('ctrl+shift+7')
  })
  it('preserves symbol keys: Ctrl+] -> "ctrl+]"', () => {
    expect(normalizeEventKey(ev({ key: ']', ctrlKey: true }), false)).toBe(
      'ctrl+]',
    )
  })
  it('returns null with no primary modifier', () => {
    expect(normalizeEventKey(ev({ key: 'b' }), false)).toBeNull()
  })
  it('returns null when Alt is held (never part of FORMAT_HOTKEYS)', () => {
    expect(
      normalizeEventKey(ev({ key: 'b', ctrlKey: true, altKey: true }), false),
    ).toBeNull()
  })
  it('returns null for Ctrl+B on mac (wrong modifier for the platform)', () => {
    expect(normalizeEventKey(ev({ key: 'b', ctrlKey: true }), true)).toBeNull()
  })
})

describe('isPromotedFormatHotkey', () => {
  it('matches a kept-key row (Ctrl+B / Cmd+B)', () => {
    expect(isPromotedFormatHotkey(ev({ key: 'b', ctrlKey: true }), false)).toBe(
      true,
    )
    expect(isPromotedFormatHotkey(ev({ key: 'b', metaKey: true }), true)).toBe(
      true,
    )
  })
  it('matches a remapped row (Ctrl+Shift+7)', () => {
    expect(
      isPromotedFormatHotkey(
        ev({ key: '7', ctrlKey: true, shiftKey: true }),
        false,
      ),
    ).toBe(true)
  })
  it('does not match a non-promoted chord (Ctrl+S)', () => {
    expect(isPromotedFormatHotkey(ev({ key: 's', ctrlKey: true }), false)).toBe(
      false,
    )
  })
  it('does not match undo/redo (VS Code Undo/Redo keybindings own those)', () => {
    expect(isPromotedFormatHotkey(ev({ key: 'z', ctrlKey: true }), false)).toBe(
      false,
    )
  })
})

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

// The keydown listener in each binding state. Bindings live in FORMAT_HOTKEYS (the manifest's
// source); the native guard must not read them.
describe('setupFormatHotkeyGuard binding independence', () => {
  afterEach(() => {
    vi.doUnmock('../../../src/shared/format-hotkeys')
    vi.doUnmock('./undo-boundaries')
    vi.resetModules()
    document.body.replaceChildren()
    ;(window as any).vditor = undefined
  })

  const BOLD: FormatHotkey = {
    toolbarName: 'bold',
    command: 'vmde.format.bold',
    key: 'ctrl+b',
    mac: 'cmd+b',
    label: 'Bold',
  }
  const TABLES: Record<string, readonly FormatHotkey[]> = {
    bound: [BOLD],
    unbound: [],
    remapped: [{ ...BOLD, key: 'ctrl+shift+b', mac: 'cmd+shift+b' }],
  }

  async function installGuard(table: readonly FormatHotkey[]) {
    vi.resetModules()
    vi.doMock('../../../src/shared/format-hotkeys', () => ({
      FORMAT_HOTKEYS: table,
    }))
    const bridged = vi.fn()
    vi.doMock('./undo-boundaries', () => ({
      markToolbarHotkeyKeydownBridged: bridged,
    }))
    const { setupFormatHotkeyGuard } = await import('./format-hotkey-guard')
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
    return { press, bridged, listeners, surface }
  }

  it.each(Object.keys(TABLES))(
    'blocks trusted Ctrl+B/I/U and never stops propagation when bold is %s',
    async (state) => {
      const { press, listeners } = await installGuard(TABLES[state])
      expect(listeners.get('keydown')?.capture).toBe(true)
      for (const key of ['b', 'i', 'u']) {
        const event = press({ key, ctrlKey: true })
        expect(event.preventDefault).toHaveBeenCalled()
        expect(event.stopPropagation).not.toHaveBeenCalled()
        expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
      }
    },
  )

  it.each(Object.keys(TABLES))(
    'blocks native select-all on the surface but not in an input, when bold is %s',
    async (state) => {
      const { press } = await installGuard(TABLES[state])
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
    },
  )

  it('leaves an untrusted unbound Ctrl+B alone (it cannot run a native command)', async () => {
    const { press } = await installGuard(TABLES.unbound)
    expect(
      press({ key: 'b', ctrlKey: true, isTrusted: false }).preventDefault,
    ).not.toHaveBeenCalled()
  })

  it('takes no action while an IME composition is active', async () => {
    const { press } = await installGuard(TABLES.bound)
    expect(
      press({ key: 'b', ctrlKey: true, isComposing: true }).preventDefault,
    ).not.toHaveBeenCalled()
  })

  it('still marks the remaining FORMAT_HOTKEYS keydowns bridged (transitional boundary coupling)', async () => {
    const bound = await installGuard(TABLES.bound)
    const boldPress = bound.press({ key: 'b', ctrlKey: true })
    expect(bound.bridged).toHaveBeenCalledWith(boldPress)

    const remapped = await installGuard(TABLES.remapped)
    remapped.press({ key: 'b', ctrlKey: true })
    expect(remapped.bridged).not.toHaveBeenCalled()
    const remappedPress = remapped.press({
      key: 'b',
      ctrlKey: true,
      shiftKey: true,
    })
    expect(remapped.bridged).toHaveBeenCalledWith(remappedPress)
    expect(remappedPress.preventDefault).toHaveBeenCalled()
  })
})
