import { describe, expect, it } from 'vitest'
import {
  applyUndoRedoKeys,
  buildUndoRedoMatcher,
  currentUndoRedoMatcher,
  keyPlatform,
  matchUndoRedo,
  parseChord,
} from './undo-redo-keys'

const key = (
  k: string,
  code: string,
  mods: Partial<
    Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>
  > = {},
  altGraph = false,
) => ({
  key: k,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
  getModifierState: (name: string) => name === 'AltGraph' && altGraph,
})

describe('undo-redo-keys defaults (Q-240)', () => {
  const linux = buildUndoRedoMatcher(undefined, 'linux')
  const mac = buildUndoRedoMatcher(undefined, 'mac')
  it('owns Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y off macOS', () => {
    expect(matchUndoRedo(linux, key('z', 'KeyZ', { ctrlKey: true }))).toBe(
      'undo',
    )
    expect(
      matchUndoRedo(linux, key('Z', 'KeyZ', { ctrlKey: true, shiftKey: true })),
    ).toBe('redo')
    expect(matchUndoRedo(linux, key('y', 'KeyY', { ctrlKey: true }))).toBe(
      'redo',
    )
  })
  it('owns Cmd+Z and Cmd+Shift+Z on macOS, not Ctrl+Y or Ctrl+Z', () => {
    expect(matchUndoRedo(mac, key('z', 'KeyZ', { metaKey: true }))).toBe('undo')
    expect(
      matchUndoRedo(mac, key('z', 'KeyZ', { metaKey: true, shiftKey: true })),
    ).toBe('redo')
    expect(
      matchUndoRedo(mac, key('y', 'KeyY', { ctrlKey: true })),
    ).toBeUndefined()
    expect(
      matchUndoRedo(mac, key('z', 'KeyZ', { ctrlKey: true })),
    ).toBeUndefined()
  })
  it('needs the exact modifiers', () => {
    expect(
      matchUndoRedo(linux, key('z', 'KeyZ', { ctrlKey: true, altKey: true })),
    ).toBeUndefined()
    expect(matchUndoRedo(linux, key('z', 'KeyZ'))).toBeUndefined()
  })
  it('excludes AltGraph, Dead, Process and Unidentified first', () => {
    expect(
      matchUndoRedo(linux, key('z', 'KeyZ', { ctrlKey: true }, true)),
    ).toBeUndefined()
    for (const k of ['Dead', 'Process', 'Unidentified'])
      expect(
        matchUndoRedo(linux, key(k, 'KeyZ', { ctrlKey: true })),
      ).toBeUndefined()
  })
  it('compares the ASCII label first (AZERTY Z on KeyW), then the physical key for a non-ASCII label', () => {
    expect(matchUndoRedo(linux, key('z', 'KeyW', { ctrlKey: true }))).toBe(
      'undo',
    )
    expect(
      matchUndoRedo(linux, key('w', 'KeyZ', { ctrlKey: true })),
    ).toBeUndefined()
    expect(matchUndoRedo(linux, key('я', 'KeyZ', { ctrlKey: true }))).toBe(
      'undo',
    )
  })
})

describe('undo-redo-keys settings', () => {
  it('matches a shifted digit by its physical key (`!` on Digit1)', () => {
    const m = buildUndoRedoMatcher({ undo: ['ctrl+shift+1'] }, 'linux')
    expect(
      matchUndoRedo(m, key('!', 'Digit1', { ctrlKey: true, shiftKey: true })),
    ).toBe('undo')
    expect(
      matchUndoRedo(m, key('@', 'Digit2', { ctrlKey: true, shiftKey: true })),
    ).toBeUndefined()
  })
  it('matches named keys through their own branch (Home, F2, Backspace)', () => {
    const m = buildUndoRedoMatcher(
      { undo: ['ctrl+home', 'alt+backspace'], redo: ['ctrl+f2'] },
      'linux',
    )
    expect(matchUndoRedo(m, key('Home', 'Home', { ctrlKey: true }))).toBe(
      'undo',
    )
    expect(matchUndoRedo(m, key('F2', 'F2', { ctrlKey: true }))).toBe('redo')
    expect(
      matchUndoRedo(m, key('Backspace', 'Backspace', { altKey: true })),
    ).toBe('undo')
    expect(
      matchUndoRedo(m, key('h', 'KeyH', { ctrlKey: true })),
    ).toBeUndefined()
    expect(
      matchUndoRedo(m, key('End', 'End', { ctrlKey: true })),
    ).toBeUndefined()
  })
  it('applies platform prefixes and skips other platforms without counting them invalid', () => {
    const settings = { undo: ['win:ctrl+u', '!win:alt+u'] }
    const win = buildUndoRedoMatcher(settings, 'win')
    const linux = buildUndoRedoMatcher(settings, 'linux')
    expect(matchUndoRedo(win, key('u', 'KeyU', { ctrlKey: true }))).toBe('undo')
    expect(
      matchUndoRedo(win, key('u', 'KeyU', { altKey: true })),
    ).toBeUndefined()
    expect(matchUndoRedo(linux, key('u', 'KeyU', { altKey: true }))).toBe(
      'undo',
    )
    expect(win.invalid).toBe(0)
  })
  it('drops and counts invalid entries: non-strings, unknown tokens and prefixes, no command modifier, two keys', () => {
    const m = buildUndoRedoMatcher(
      {
        undo: [
          3,
          'ctrl+zz',
          'foo:ctrl+z',
          'shift+z',
          'z',
          'ctrl+a+b',
          'ctrl+z',
        ],
        redo: 'mod+y',
      },
      'linux',
    )
    expect(m.invalid).toBe(7)
    expect(m.undo).toHaveLength(1)
    expect(m.redo).toHaveLength(0)
  })
  it('keeps at most 8 entries and counts the rest', () => {
    const letters = 'abcdefghij'.split('').map((c) => `ctrl+alt+${c}`)
    const m = buildUndoRedoMatcher({ undo: letters }, 'linux')
    expect(m.undo).toHaveLength(8)
    expect(m.invalid).toBe(2)
  })
  it('removes duplicates after normalization, and a Redo chord already given to Undo', () => {
    const m = buildUndoRedoMatcher(
      {
        undo: ['Ctrl+Z', 'mod+z', ' control + z '],
        redo: ['ctrl+z', 'ctrl+y'],
      },
      'linux',
    )
    expect(m.undo).toHaveLength(1)
    expect(m.redo).toHaveLength(1)
    expect(m.invalid).toBe(0)
  })
  it('turns ownership off only for inEditor false', () => {
    expect(buildUndoRedoMatcher({ inEditor: false }, 'linux').inEditor).toBe(
      false,
    )
    expect(buildUndoRedoMatcher({ inEditor: 'no' }, 'linux').inEditor).toBe(
      true,
    )
  })
  it('parseChord maps mod per platform', () => {
    expect(parseChord('mod+z', 'mac')).toMatchObject({
      meta: true,
      ctrl: false,
    })
    expect(parseChord('mod+z', 'win')).toMatchObject({
      meta: false,
      ctrl: true,
    })
  })
  it('swaps the current matcher whole on apply', () => {
    const before = currentUndoRedoMatcher()
    applyUndoRedoKeys({ undo: ['ctrl+alt+q'] }, 'linux')
    const after = currentUndoRedoMatcher()
    expect(after).not.toBe(before)
    expect(Object.isFrozen(after)).toBe(true)
    expect(
      matchUndoRedo(after, key('q', 'KeyQ', { ctrlKey: true, altKey: true })),
    ).toBe('undo')
    applyUndoRedoKeys(undefined, 'linux')
  })
  it('keyPlatform reads navigator.platform', () => {
    expect(keyPlatform({ platform: 'MacIntel' })).toBe('mac')
    expect(keyPlatform({ platform: 'Win32' })).toBe('win')
    expect(keyPlatform({ platform: 'Linux x86_64' })).toBe('linux')
  })
})
