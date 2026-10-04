// Task 580 CP3-1 — successor of Task 505's FORMAT_HOTKEYS drift guard. The shared shortcut table
// (src/shared/editor-shortcuts.ts) is the single owner of every VMDE shortcut; package.json is a
// static manifest that cannot import it, so this test keeps the manifest from drifting: commands,
// keybindings (exactly, in table order) and Command Palette gates all equal what the table
// derives. The formatting toolbar's whitelist and tooltips derive from the same rows.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  EDITOR_SHORTCUTS,
  TOOLBAR_COMMAND_NAMES,
  commandPaletteWhen,
  contributedKeybindings,
  toolbarTip,
} from '../../src/shared/editor-shortcuts'

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  contributes: {
    commands: { command: string; title: string; category?: string }[]
    keybindings: unknown[]
    menus: { commandPalette: { command: string; when?: string }[] }
  }
}

const row = (command: string) => {
  const found = EDITOR_SHORTCUTS.find((r) => r.command === command)
  if (!found) throw new Error(`${command} is not in the table`)
  return found
}

describe('package.json equals the shared shortcut table', () => {
  it('contributes every table command once, with its title and the VMDE category', () => {
    for (const { command, title } of EDITOR_SHORTCUTS) {
      expect(
        pkg.contributes.commands.filter((c) => c.command === command),
        command,
      ).toEqual([expect.objectContaining({ command, title, category: 'VMDE' })])
    }
  })

  it('contributes exactly the table keybindings, in table order', () => {
    expect(pkg.contributes.keybindings).toEqual(
      EDITOR_SHORTCUTS.flatMap(contributedKeybindings),
    )
  })

  it('gates every table command in the Command Palette to VMDE (and the Find widget)', () => {
    for (const shortcut of EDITOR_SHORTCUTS) {
      expect(
        pkg.contributes.menus.commandPalette.filter(
          (p) => p.command === shortcut.command,
        ),
        shortcut.command,
      ).toEqual([
        { command: shortcut.command, when: commandPaletteWhen(shortcut) },
      ])
    }
  })

  it('binds no formatting default beyond Bold, Italic, Indent, Outdent, Undo and Redo', () => {
    const bound = new Set(
      EDITOR_SHORTCUTS.filter(
        (r) => r.command.startsWith('vmde.format.') && r.keys !== 'unbound',
      ).map((r) => r.command),
    )
    expect(bound).toEqual(
      new Set([
        'vmde.format.bold',
        'vmde.format.italic',
        'vmde.format.indent',
        'vmde.format.outdent',
        'vmde.format.undo',
        'vmde.format.redo',
      ]),
    )
  })
})

// VS Code reads `mac`, then `key` on macOS and `win`/`linux`, then `key` elsewhere; an empty string
// falls through (Part 1 handoff F2).
describe('contributedKeybindings', () => {
  it('pairs one key per platform family in one entry', () => {
    expect(contributedKeybindings(row('vmde.format.bold'))).toEqual([
      {
        key: 'ctrl+b',
        command: 'vmde.format.bold',
        mac: 'cmd+b',
        when: row('vmde.format.bold').when,
      },
    ])
  })

  it('gives a Windows/Linux-only key an empty `key` plus `win` and `linux`', () => {
    const redo = row('vmde.format.redo')
    expect(contributedKeybindings(redo)).toEqual([
      {
        key: 'ctrl+y',
        command: 'vmde.format.redo',
        mac: 'cmd+shift+z',
        when: redo.when,
      },
      {
        key: '',
        command: 'vmde.format.redo',
        linux: 'ctrl+shift+z',
        win: 'ctrl+shift+z',
        when: redo.when,
      },
    ])
  })

  it('gives a macOS-only key an empty `key` plus `mac`', () => {
    const next = row('vmde.findNext')
    expect(contributedKeybindings(next)).toEqual([
      { key: 'f3', command: 'vmde.findNext', mac: 'f3', when: next.when },
      { key: '', command: 'vmde.findNext', mac: 'cmd+g', when: next.when },
    ])
  })

  it('contributes nothing for an unbound command', () => {
    expect(contributedKeybindings(row('vmde.format.strike'))).toEqual([])
    expect(contributedKeybindings(row('vmde.pastePlain'))).toEqual([])
  })
})

describe('formatting toolbar rows', () => {
  it('whitelists exactly the toolbar items the format commands click', () => {
    expect([...TOOLBAR_COMMAND_NAMES].sort()).toEqual(
      [
        'bold',
        'italic',
        'strike',
        'headings',
        'list',
        'ordered-list',
        'check',
        'outdent',
        'indent',
        'quote',
        'code',
        'inline-code',
        'undo',
        'redo',
      ].sort(),
    )
  })

  it('builds "<label> (<Display Key>)" for a bound command, per platform', () => {
    expect(toolbarTip('bold', false)).toBe('Bold (Ctrl+B)')
    expect(toolbarTip('bold', true)).toBe('Bold (Cmd+B)')
    expect(toolbarTip('indent', false)).toBe('Indent (Ctrl+])')
    expect(toolbarTip('outdent', true)).toBe('Outdent (Cmd+[)')
  })

  it('uses the bare label for an unbound command', () => {
    expect(toolbarTip('ordered-list', false)).toBe('Numbered List')
    expect(toolbarTip('headings', true)).toBe('Headings')
    expect(toolbarTip('inline-code', true)).toBe('Inline Code')
  })

  it('throws for a toolbar item no command clicks', () => {
    expect(() => toolbarTip('preview', false)).toThrow(/not a toolbar command/)
  })
})
