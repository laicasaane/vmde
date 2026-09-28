import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  FORMAT_HOTKEYS,
  UNBOUND_FORMAT_COMMANDS,
  formatTip,
} from '../../src/shared/format-hotkeys'

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
)
const WHEN = 'activeCustomEditorId == vmde.editor'

describe('FORMAT_HOTKEYS (task 505 single source of truth)', () => {
  it('has exactly the 12 promoted rows', () => {
    expect(FORMAT_HOTKEYS).toHaveLength(12)
  })

  it('every row has a unique toolbarName and command', () => {
    const toolbarNames = FORMAT_HOTKEYS.map((r) => r.toolbarName)
    const commands = FORMAT_HOTKEYS.map((r) => r.command)
    expect(new Set(toolbarNames).size).toBe(toolbarNames.length)
    expect(new Set(commands).size).toBe(commands.length)
  })

  it('has no duplicate key or mac binding across rows', () => {
    const keys = FORMAT_HOTKEYS.map((r) => r.key)
    const macs = FORMAT_HOTKEYS.map((r) => r.mac)
    expect(new Set(keys).size).toBe(keys.length)
    expect(new Set(macs).size).toBe(macs.length)
  })

  it('mac notation is the same key family as win/linux (ctrl+X <-> cmd+X)', () => {
    for (const row of FORMAT_HOTKEYS) {
      if (row.key === '') {
        expect(row.toolbarName).toBe('headings')
        expect(row.mac).toBe('cmd+h')
        continue
      }
      expect(row.key.startsWith('ctrl+'), row.toolbarName).toBe(true)
      expect(row.mac.startsWith('cmd+'), row.toolbarName).toBe(true)
      expect(row.mac.slice('cmd+'.length), row.toolbarName).toBe(
        row.key.slice('ctrl+'.length),
      )
    }
  })

  it('every command id is vmde.format.<toolbarName-ish>, prefixed consistently', () => {
    for (const row of FORMAT_HOTKEYS) {
      expect(row.command.startsWith('vmde.format.')).toBe(true)
    }
  })

  // The 4 remaps task 505 made away from a real workbench-command collision.
  it('remaps indent/outdent to Ctrl+[/] and ordered-list/check to Ctrl+Shift+7/9', () => {
    const byName = new Map(FORMAT_HOTKEYS.map((r) => [r.toolbarName, r]))
    expect(byName.get('outdent')).toMatchObject({ key: 'ctrl+[', mac: 'cmd+[' })
    expect(byName.get('indent')).toMatchObject({ key: 'ctrl+]', mac: 'cmd+]' })
    expect(byName.get('ordered-list')).toMatchObject({
      key: 'ctrl+shift+7',
      mac: 'cmd+shift+7',
    })
    expect(byName.get('check')).toMatchObject({
      key: 'ctrl+shift+9',
      mac: 'cmd+shift+9',
    })
  })
})

describe('UNBOUND_FORMAT_COMMANDS (undo/redo — command only, no keybinding)', () => {
  it('has exactly undo and redo, and neither appears in FORMAT_HOTKEYS', () => {
    expect(UNBOUND_FORMAT_COMMANDS.map((c) => c.toolbarName)).toEqual([
      'undo',
      'redo',
    ])
    const promotedNames = new Set(FORMAT_HOTKEYS.map((r) => r.toolbarName))
    expect(promotedNames.has('undo')).toBe(false)
    expect(promotedNames.has('redo')).toBe(false)
  })
})

describe('formatTip', () => {
  it('uses a bare label where the platform has no keybinding', () => {
    const row = FORMAT_HOTKEYS.find((r) => r.toolbarName === 'headings')!
    expect(formatTip(row.label, false, row)).toBe('Headings')
    expect(formatTip(row.label, true, row)).toBe('Headings (Cmd+H)')
  })

  it('builds "<label> (<Display Key>)" for win/linux', () => {
    const row = FORMAT_HOTKEYS.find((r) => r.toolbarName === 'ordered-list')!
    expect(formatTip(row.label, false, row)).toBe(
      'Numbered List (Ctrl+Shift+7)',
    )
  })

  it('builds "<label> (<Display Key>)" for mac', () => {
    const row = FORMAT_HOTKEYS.find((r) => r.toolbarName === 'ordered-list')!
    expect(formatTip(row.label, true, row)).toBe('Numbered List (Cmd+Shift+7)')
  })

  it('formats a single-symbol key (e.g. Ctrl+]) without mangling the symbol', () => {
    const row = FORMAT_HOTKEYS.find((r) => r.toolbarName === 'indent')!
    expect(formatTip(row.label, false, row)).toBe('Indent (Ctrl+])')
    expect(formatTip(row.label, true, row)).toBe('Indent (Cmd+])')
  })

  it('formats a punctuation key (Ctrl+;)', () => {
    const row = FORMAT_HOTKEYS.find((r) => r.toolbarName === 'quote')!
    expect(formatTip(row.label, false, row)).toBe('Blockquote (Ctrl+;)')
  })
})

// The drift guard (task 505 §2): package.json is a static manifest that can't import
// FORMAT_HOTKEYS, so this test is what keeps it from silently drifting — mirrors
// manifest.test.ts's package.json-read pattern and toolbar-overflow.test.ts's
// KNOWN_TOOLBAR_ITEMS drift-guard shape.
describe('package.json drift guard (contributes.commands / keybindings vs FORMAT_HOTKEYS)', () => {
  const commandIds = new Set(
    (pkg.contributes.commands as { command: string }[]).map((c) => c.command),
  )
  const keybindingsByCommand = new Map(
    (pkg.contributes.keybindings as { command: string }[]).map((k) => [
      k.command,
      k,
    ]),
  )

  it('every FORMAT_HOTKEYS row has a matching command + keybinding (exact key/mac/when)', () => {
    for (const row of FORMAT_HOTKEYS) {
      expect(commandIds.has(row.command), row.command).toBe(true)
      const kb = keybindingsByCommand.get(row.command)
      expect(
        kb,
        `${row.command} has no contributes.keybindings entry`,
      ).toBeDefined()
      expect(kb).toMatchObject({ key: row.key, mac: row.mac, when: WHEN })
    }
  })

  it('undo/redo have a command but NO keybinding entry', () => {
    for (const { command } of UNBOUND_FORMAT_COMMANDS) {
      expect(commandIds.has(command), command).toBe(true)
      expect(
        keybindingsByCommand.has(command),
        `${command} must NOT have a keybinding — undo-keybind.ts owns its key`,
      ).toBe(false)
    }
  })

  it('has no vmde.format.* keybinding beyond the 12 FORMAT_HOTKEYS rows', () => {
    const boundFormatCommands = [
      ...(pkg.contributes.keybindings as { command: string }[]),
    ]
      .map((k) => k.command)
      .filter((c) => c.startsWith('vmde.format.'))
    expect(new Set(boundFormatCommands)).toEqual(
      new Set(FORMAT_HOTKEYS.map((r) => r.command)),
    )
  })
})
