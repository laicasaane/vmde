// @vitest-environment jsdom
// Task 580 CP2-1 — the Chromium-harness keybinding shim (media-src/e2e/keybinding-shim.ts) maps
// the shared table's default keys to routes only for the commands a spec enables.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chordOf,
  installKeybindingShim,
} from '../../media-src/e2e/keybinding-shim'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function press(init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

function install(platform: 'win-linux' | 'mac', commands: string[]) {
  const dispatch = vi.fn()
  cleanups.push(installKeybindingShim(window, { platform, commands, dispatch }))
  return dispatch
}

describe('keybinding shim', () => {
  it('spells chords in VS Code notation from the physical key', () => {
    expect(
      chordOf(
        {
          code: 'BracketLeft',
          ctrlKey: true,
          shiftKey: true,
          altKey: false,
          metaKey: false,
        },
        'win-linux',
      ),
    ).toBe('ctrl+shift+[')
    expect(
      chordOf(
        {
          code: 'ArrowRight',
          ctrlKey: true,
          shiftKey: true,
          altKey: false,
          metaKey: true,
        },
        'mac',
      ),
    ).toBe('ctrl+shift+cmd+right')
    expect(
      chordOf(
        {
          code: 'ShiftLeft',
          ctrlKey: false,
          shiftKey: true,
          altKey: false,
          metaKey: false,
        },
        'mac',
      ),
    ).toBeNull()
  })

  it('dispatches the route of an enabled command and prevents the default', () => {
    const dispatch = install('win-linux', ['vmde.fold'])
    const event = press({ code: 'BracketLeft', ctrlKey: true, shiftKey: true })
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      { command: 'editor-action', action: 'fold' },
      'vmde.fold',
    )
    expect(event.defaultPrevented).toBe(true)
  })

  // Task 580 CP2-8 — an unbound command runs only from a key the user binds.
  it('dispatches an unbound command from a user key and ignores its former default', () => {
    const dispatch = vi.fn()
    cleanups.push(
      installKeybindingShim(window, {
        platform: 'win-linux',
        commands: ['vmde.activateLinkAtCaret'],
        userKeys: { 'alt+l': 'vmde.activateLinkAtCaret' },
        dispatch,
      }),
    )
    expect(press({ code: 'Enter', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
    const event = press({ code: 'KeyL', altKey: true })
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      { command: 'activate-link-at-caret' },
      'vmde.activateLinkAtCaret',
    )
    expect(event.defaultPrevented).toBe(true)
  })

  it('ignores the default key of a command the spec did not enable', () => {
    const dispatch = install('win-linux', ['vmde.fold'])
    const event = press({ code: 'KeyB', ctrlKey: true })
    expect(dispatch).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('uses the macOS keys on the mac platform', () => {
    const dispatch = install('mac', ['vmde.fold', 'vmde.findNext'])
    press({ code: 'BracketLeft', metaKey: true, altKey: true })
    press({ code: 'KeyG', metaKey: true })
    expect(dispatch.mock.calls.map(([, command]) => command)).toEqual([
      'vmde.fold',
      'vmde.findNext',
    ])
  })

  it('resolves a two-part chord across two keydowns', () => {
    const dispatch = install('win-linux', ['vmde.toggleSectionFold'])
    press({ code: 'KeyK', ctrlKey: true })
    expect(dispatch).not.toHaveBeenCalled()
    press({ code: 'KeyL', ctrlKey: true })
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      { command: 'toggle-section-fold' },
      'vmde.toggleSectionFold',
    )
    press({ code: 'KeyL', ctrlKey: true })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('stops dispatching once removed', () => {
    const dispatch = vi.fn()
    const remove = installKeybindingShim(window, {
      platform: 'win-linux',
      commands: ['vmde.format.bold'],
      dispatch,
    })
    remove()
    press({ code: 'KeyB', ctrlKey: true })
    expect(dispatch).not.toHaveBeenCalled()
  })
})
