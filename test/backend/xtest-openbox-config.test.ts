import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { windowManagerDesktopError } from '../../test/vscode-e2e/helpers/xtest-input'

const CONFIG = resolve(__dirname, '../vscode-e2e/xtest-openbox.xml')

describe('tracked XTEST Openbox configuration', () => {
  it('binds no keys and keeps one desktop', () => {
    const xml = readFileSync(CONFIG, 'utf8')
    expect(xml).not.toContain('<keybind')
    expect(xml).toMatch(/<desktops>\s*<number>1<\/number>\s*<\/desktops>/)
  })
})

describe('windowManagerDesktopError', () => {
  it('accepts a window manager with one desktop', () => {
    expect(windowManagerDesktopError('1')).toBeNull()
  })

  it('names the desktop count and the tracked configuration when there are more', () => {
    expect(windowManagerDesktopError('4')).toBe(
      'the window manager reports 4 desktops; start Openbox with --config-file test/vscode-e2e/xtest-openbox.xml so it grabs no key chords (its default Shift+Alt+Left/Right bindings swallow Shrink/Expand Selection)',
    )
  })

  it('rejects output that is not a desktop count', () => {
    expect(windowManagerDesktopError('x')).toBe(
      'xdotool get_num_desktops returned "x"',
    )
  })
})
