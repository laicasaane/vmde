// Task 580 CP2-1 — the shared shortcut table (src/shared/editor-shortcuts.ts) holds the
// Checkpoint 1 target table. These checks pin its shape against the task record's counts, the
// pinned VS Code defaults fixture and the webview routes. Since CP3-1 the table is the single
// owner: test/backend/format-hotkeys.test.ts checks package.json against it, and
// commands-and-handlers.test.ts checks that each registration posts its row's route.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  EDITOR_SHORTCUTS,
  VMDE_FIND_WIDGET_WHEN,
  VMDE_SHORTCUT_WHEN,
} from '../../src/shared/editor-shortcuts'

type Os = 'win' | 'linux' | 'mac'
const fixture = JSON.parse(
  readFileSync(
    new URL('./vscode-default-keybindings-1.129.0.json', import.meta.url),
    'utf8',
  ),
) as {
  mirrors: Record<string, { command: string; keys: Record<Os, string[]> }>
}

// Modifier order differs between notations (`cmd+alt+[` vs `alt+cmd+[`); compare sorted parts.
const normalize = (keys: readonly string[]) =>
  keys
    .map((key) =>
      key
        .split(' ')
        .map((part) => {
          const segments = part.split('+')
          const base = segments.pop()
          return [...segments.sort(), base].join('+')
        })
        .join(' '),
    )
    .sort()

const boundRows = EDITOR_SHORTCUTS.filter((row) => row.keys !== 'unbound')
const unboundRows = EDITOR_SHORTCUTS.filter((row) => row.keys === 'unbound')

describe('Task 580 shared shortcut table', () => {
  it('holds the 22 bound and 44 unbound target commands once each', () => {
    const commands = EDITOR_SHORTCUTS.map((row) => row.command)
    expect(boundRows).toHaveLength(22)
    expect(unboundRows).toHaveLength(44)
    expect(new Set(commands).size).toBe(commands.length)
  })

  it('uses G1 for every binding and adds the widget predicate only to Find-widget commands', () => {
    expect(VMDE_SHORTCUT_WHEN).toBe(
      'activeCustomEditorId == vmde.editor && !inputFocus && !sideBarFocus && !panelFocus && !auxiliaryBarFocus',
    )
    for (const row of boundRows) {
      const findWidget =
        row.route !== 'host' && row.route.command === 'find-widget-action'
      expect(row.when, row.command).toBe(
        findWidget ? VMDE_FIND_WIDGET_WHEN : VMDE_SHORTCUT_WHEN,
      )
    }
  })

  it('gives unbound rows no `when` and the VMDE-only identity', () => {
    for (const row of unboundRows) {
      expect(row.when, row.command).toBeUndefined()
      expect(row.identity, row.command).toEqual({ kind: 'vmde-only' })
    }
  })

  it('marks only Bold and Italic as convention keys', () => {
    expect(
      boundRows
        .filter((row) => row.identity.kind === 'convention')
        .map((row) => row.command),
    ).toEqual(['vmde.format.bold', 'vmde.format.italic'])
  })

  it('mirrors each VS Code command with its pinned default keys on every platform', () => {
    const mirrored = boundRows.filter((row) => row.identity.kind === 'mirror')
    expect(mirrored.map((row) => row.command).sort()).toEqual(
      Object.keys(fixture.mirrors).sort(),
    )
    for (const row of mirrored) {
      if (row.keys === 'unbound' || row.identity.kind !== 'mirror') continue
      const pinned = fixture.mirrors[row.command]
      expect(pinned.command, row.command).toBe(row.identity.vscodeCommand)
      for (const os of ['win', 'linux'] as const)
        expect(normalize(row.keys.winLinux), `${row.command} ${os}`).toEqual(
          normalize(pinned.keys[os]),
        )
      expect(normalize(row.keys.mac), `${row.command} mac`).toEqual(
        normalize(pinned.keys.mac),
      )
    }
  })

  it('routes each format command to its toolbar item', () => {
    const tableRoutes = EDITOR_SHORTCUTS.flatMap((row) =>
      row.route !== 'host' && row.route.command === 'trigger-toolbar-hotkey'
        ? [`${row.command} -> ${row.route.name}`]
        : [],
    ).sort()
    expect(tableRoutes).toEqual(
      [
        'vmde.format.bold -> bold',
        'vmde.format.italic -> italic',
        'vmde.format.strike -> strike',
        'vmde.format.headings -> headings',
        'vmde.format.list -> list',
        'vmde.format.orderedList -> ordered-list',
        'vmde.format.check -> check',
        'vmde.format.outdent -> outdent',
        'vmde.format.indent -> indent',
        'vmde.format.quote -> quote',
        'vmde.format.code -> code',
        'vmde.format.inlineCode -> inline-code',
        'vmde.format.undo -> undo',
        'vmde.format.redo -> redo',
      ].sort(),
    )
  })

  it('routes each Find-widget command to its widget action', () => {
    const tableRoutes = EDITOR_SHORTCUTS.flatMap((row) =>
      row.route !== 'host' && row.route.command === 'find-widget-action'
        ? [`${row.command} -> ${row.route.action}`]
        : [],
    ).sort()
    expect(tableRoutes).toEqual(
      [
        'vmde.findNext -> next',
        'vmde.findPrevious -> previous',
        'vmde.toggleFindCaseSensitive -> toggle-case',
        'vmde.toggleFindWholeWord -> toggle-whole-word',
        'vmde.replaceOne -> replace-one',
        'vmde.replaceAll -> replace-all',
        'vmde.closeFindWidget -> close',
      ].sort(),
    )
  })

  it('leaves only Paste as Plain Text and Edit in Text Editor to the host', () => {
    expect(
      EDITOR_SHORTCUTS.filter((row) => row.route === 'host').map(
        (row) => row.command,
      ),
    ).toEqual(['vmde.pastePlain', 'vmde.openTextEditor'])
  })

  it('gives every editor action exactly one command', () => {
    const actions = EDITOR_SHORTCUTS.flatMap((row) =>
      row.route !== 'host' && row.route.command === 'editor-action'
        ? [row.route.action]
        : [],
    )
    expect(actions).toHaveLength(29)
    expect(new Set(actions).size).toBe(actions.length)
  })
})
