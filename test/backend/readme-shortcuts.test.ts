// Task 580 CP3-3 — keeps README.md's "Keyboard shortcuts" section equal to the shared shortcut table
// (src/shared/editor-shortcuts.ts) and to package.json's contributed keybindings. The parser reads
// only what matters, so prose, column order and key spelling (`Cmd+Alt+[` vs `cmd+alt+[`) can change
// freely:
//   - a table under the section with a Command column plus Windows/Linux and macOS columns lists
//     bound commands; each key is one code span in its cell;
//   - the "Commands without a default key" subsection lists unbound commands as code spans.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  EDITOR_SHORTCUTS,
  type EditorShortcut,
} from '../../src/shared/editor-shortcuts'

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  contributes: {
    commands: { command: string }[]
    customEditors: { viewType: string }[]
    keybindings: {
      key: string
      command: string
      mac?: string
      win?: string
      linux?: string
    }[]
  }
}

/** The lines from a heading matching `heading` up to the next heading of the same or a higher
 *  level. */
function section(text: string, heading: RegExp): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => heading.test(line))
  if (start < 0) throw new Error(`README has no heading matching ${heading}`)
  const level = /^#+/.exec(lines[start])?.[0].length ?? 0
  const end = lines.findIndex(
    (line, i) =>
      i > start && /^#+ /.test(line) && /^#+/.exec(line)![0].length <= level,
  )
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}

/** The inline code spans of `text`, outside fenced code blocks (whose backticks would pair up with
 *  the wrong span). */
const codeSpans = (text: string) =>
  [
    ...text
      .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '')
      .matchAll(/`([^`\n]+)`/g),
  ].map((m) => m[1])

/** Splits a Markdown table row on the pipes outside code spans. */
function cells(row: string): string[] {
  const out: string[] = []
  let cell = ''
  let inCode = false
  for (const ch of row.trim().replace(/^\|/, '').replace(/\|$/, '')) {
    if (ch === '`') inCode = !inCode
    if (ch === '|' && !inCode) {
      out.push(cell.trim())
      cell = ''
    } else cell += ch
  }
  out.push(cell.trim())
  return out
}

const MODIFIER_ORDER = ['ctrl', 'shift', 'alt', 'cmd']
const ALIASES: Record<string, string> = {
  control: 'ctrl',
  option: 'alt',
  opt: 'alt',
  command: 'cmd',
  meta: 'cmd',
  esc: 'escape',
  return: 'enter',
}

/** One key in VS Code notation with a canonical modifier order: `Cmd+Alt+[` → `alt+cmd+[`,
 *  `Ctrl+K Ctrl+L` → `ctrl+k ctrl+l`. */
function normalizeKey(key: string): string {
  return key
    .trim()
    .split(/\s+/)
    .map((stroke) => {
      const parts = stroke
        .toLowerCase()
        .split('+')
        .map((p) => ALIASES[p] ?? p)
      const base = parts.pop() ?? ''
      const mods = parts.sort(
        (a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b),
      )
      return [...mods, base].join('+')
    })
    .join(' ')
}

const sortedKeys = (keys: readonly string[]) => keys.map(normalizeKey).sort()

interface ReadmeRow {
  winLinux: string[]
  mac: string[]
  identity: string
}

/** The Markdown tables of `text`, each as its row lines (header first). */
function tables(text: string): string[][] {
  const found: string[][] = []
  let inTable = false
  for (const line of text.split('\n')) {
    const isRow = line.trim().startsWith('|')
    if (isRow && !inTable) found.push([])
    if (isRow) found[found.length - 1].push(line)
    inTable = isRow
  }
  return found
}

/** The bound rows of one table by command ID, or none when it is not a shortcut table (no Command,
 *  Windows/Linux and macOS columns). */
function tableRows([header, ...body]: string[]): [string, ReadmeRow][] {
  const names = cells(header).map((c) => c.toLowerCase())
  const column = (pattern: RegExp) => names.findIndex((n) => pattern.test(n))
  const command = column(/command/)
  const winLinux = column(/windows|linux/)
  const mac = column(/mac/)
  const identity = column(/default|mirror|identity/)
  if (command < 0 || winLinux < 0 || mac < 0) return []
  return body
    .filter((line) => !/^[\s|:-]+$/.test(line))
    .map((line) => {
      const row = cells(line)
      const id = codeSpans(row[command]).find((s) => s.startsWith('vmde.'))
      if (!id) throw new Error(`table row without a command ID: ${line}`)
      return [
        id,
        {
          winLinux: sortedKeys(codeSpans(row[winLinux])),
          mac: sortedKeys(codeSpans(row[mac])),
          identity: identity < 0 ? '' : row[identity],
        },
      ]
    })
}

/** The bound rows of every shortcut table in `text`, by command ID. */
function boundRows(text: string): Map<string, ReadmeRow> {
  const rows = new Map<string, ReadmeRow>()
  for (const [id, row] of tables(text).flatMap(tableRows)) {
    if (rows.has(id)) throw new Error(`${id} is listed twice`)
    rows.set(id, row)
  }
  return rows
}

const shortcuts = section(readme, /^## Keyboard shortcuts\s*$/)
const unboundSection = section(
  shortcuts,
  /^### Commands without a default key\s*$/,
)
const readmeBound = boundRows(shortcuts)
const tableBound = EDITOR_SHORTCUTS.filter(
  (row): row is EditorShortcut & { keys: object } => row.keys !== 'unbound',
)
const tableUnbound = EDITOR_SHORTCUTS.filter((row) => row.keys === 'unbound')

/** Each command's default keys per platform family, as package.json contributes them. VS Code reads
 *  `mac` then `key` on macOS, and `win`/`linux` then `key` elsewhere. */
function manifestKeys(command: string) {
  const entries = pkg.contributes.keybindings.filter(
    (k) => k.command === command,
  )
  const pick = (values: (string | undefined)[]) =>
    sortedKeys(values.filter((v): v is string => Boolean(v)))
  return {
    winLinux: pick(entries.map((k) => k.win || k.linux || k.key)),
    mac: pick(entries.map((k) => k.mac || k.key)),
  }
}

describe('README keyboard shortcuts equal the shared shortcut table', () => {
  it('lists exactly the bound commands in its default-key tables', () => {
    expect([...readmeBound.keys()].sort()).toEqual(
      tableBound.map((row) => row.command).sort(),
    )
  })

  it.each(tableBound)(
    '$command: README keys equal the table and package.json',
    (row) => {
      const listed = readmeBound.get(row.command)
      expect(listed, row.command).toBeDefined()
      const expected = {
        winLinux: sortedKeys(row.keys.winLinux),
        mac: sortedKeys(row.keys.mac),
      }
      expect({ winLinux: listed?.winLinux, mac: listed?.mac }).toEqual(expected)
      expect(manifestKeys(row.command)).toEqual(expected)
    },
  )

  it.each(tableBound)('$command: README names its identity', (row) => {
    const identity = readmeBound.get(row.command)?.identity ?? ''
    if (row.identity.kind === 'mirror')
      expect(codeSpans(identity)).toContain(row.identity.vscodeCommand)
    else expect(identity).toMatch(/convention/i)
  })

  it('lists exactly the unbound commands, each contributed by package.json', () => {
    const listed = codeSpans(unboundSection).filter((s) =>
      s.startsWith('vmde.'),
    )
    expect(new Set(listed).size, 'an unbound command is listed twice').toBe(
      listed.length,
    )
    expect([...listed].sort()).toEqual(
      tableUnbound.map((row) => row.command).sort(),
    )
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command))
    for (const id of listed) expect(contributed.has(id), id).toBe(true)
  })

  it('names only real VMDE commands and the VMDE editor ID in the section', () => {
    const known = new Set([
      ...pkg.contributes.commands.map((c) => c.command),
      ...pkg.contributes.customEditors.map((c) => c.viewType),
    ])
    for (const id of shortcuts.match(/\bvmde\.[\w.]*\w/g) ?? [])
      expect(known.has(id), id).toBe(true)
  })

  it('shows no stale default key anywhere in the README', () => {
    // Keys that are not VMDE defaults but that README names on purpose: VS Code's own keys and the
    // fixed widget-local keys.
    const allowed = new Set(
      [
        'Ctrl+Shift+X',
        'Cmd+Shift+X',
        'Ctrl+Shift+F',
        'Cmd+Shift+F',
        'Ctrl+K Ctrl+S',
        'Cmd+K Cmd+S',
        'Shift+Enter',
        'Cmd+Enter',
        'Shift+Arrow',
      ].map(normalizeKey),
    )
    for (const row of tableBound)
      for (const key of [...row.keys.winLinux, ...row.keys.mac])
        allowed.add(normalizeKey(key))
    const chords = codeSpans(readme).filter((s) =>
      /^(ctrl|cmd|alt|shift)(\/cmd)?\+/i.test(s),
    )
    expect(chords.length).toBeGreaterThan(0)
    for (const chord of chords) {
      // `Ctrl/Cmd+F` stands for both `Ctrl+F` and `Cmd+F`.
      const forms = /^ctrl\/cmd\+/i.test(chord)
        ? [
            chord.replace(/^ctrl\/cmd/i, 'Ctrl'),
            chord.replace(/^ctrl\/cmd/i, 'Cmd'),
          ]
        : [chord]
      for (const form of forms)
        expect(allowed.has(normalizeKey(form)), chord).toBe(true)
    }
  })
})
