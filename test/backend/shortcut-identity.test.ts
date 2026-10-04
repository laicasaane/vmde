// Task 580 Checkpoint 1 red expectations: the shortcut manifest after Task 580, checked against
// `package.json` and the pinned VS Code 1.129.0 defaults in `vscode-default-keybindings-1.129.0.json`.
// The target table is the "Final target table" in tasks/580-rectify-shortcuts-vscode-identity.md.
//
// Rows the current manifest does not meet yet carry the Task 580 step that makes them true
// (`redUntil`). Such a row runs as `it.fails`, so the suite stays green while it is red for the
// intended reason; the named step deletes the marker and the row becomes a plain `it`.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

type Os = 'win' | 'linux' | 'mac'
type Step = 'CP2-6' | 'CP2-7' | 'CP2-8' | 'CP2-9' | 'CP2-10' | 'CP3-1'

interface ManifestCommand {
  command: string
  title: string
  category?: string
}
interface ManifestBinding {
  command: string
  key?: string
  mac?: string
  linux?: string
  win?: string
  when?: string
}
interface PaletteEntry {
  command: string
  when?: string
}
interface FixtureBinding {
  command: string
  when: string | null
  keys: Record<Os, string[]>
  canHoldInVmdeWebview: boolean
}
interface Fixture {
  provenance: { vscodeVersion: string; linuxDump: string }
  mirrors: Record<
    string,
    { command: string; when: string | null; keys: Record<Os, string[]> }
  >
  keyRoles: Record<Os, Record<string, string[]>>
  bindings: FixtureBinding[]
  sanctionedCollisions: { vmdeCommand: string; vscodeCommand: string }[]
  candidateFreeRemapKeys: Record<Os, string[]>
}

const readJson = <T>(relative: string): T =>
  JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as T

const pkg = readJson<{
  contributes: {
    commands: ManifestCommand[]
    keybindings: ManifestBinding[]
    menus: { commandPalette: PaletteEntry[] }
  }
}>('../../package.json')
const fixture = readJson<Fixture>('./vscode-default-keybindings-1.129.0.json')

const OSES: readonly Os[] = ['win', 'linux', 'mac']
const VMDE_ACTIVE = 'activeCustomEditorId == vmde.editor'
// G1 from the task record: every contributed VMDE binding uses it.
const G1 = `${VMDE_ACTIVE} && !inputFocus && !sideBarFocus && !panelFocus && !auxiliaryBarFocus`
const G1_FIND = `${G1} && vmde.findWidgetVisible`

const itUntil = (step: Step | undefined) => (step ? it.fails : it)

// One canonical spelling per chord: lower case, modifiers in VS Code's own order (the order its
// default keybindings file prints), so `cmd+alt+[` and `alt+cmd+[` compare equal.
function canonicalKey(key: string, os: Os): string {
  const order =
    os === 'mac'
      ? ['ctrl', 'shift', 'alt', 'cmd']
      : ['ctrl', 'shift', 'alt', 'meta']
  return key
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((part) => {
      const segments = part.split('+')
      const base = segments.pop() ?? ''
      return [...order.filter((m) => segments.includes(m)), base].join('+')
    })
    .join(' ')
}

// VS Code's rule for extension keybindings (read in the pinned 1.129.0 bundle,
// `bindToCurrentPlatform`): Windows takes `win`, then `linux`, then `key`; macOS takes `mac`, then
// `key`; Linux takes `linux`, then `key`. An empty string falls through, so `mac: ''` does not unbind.
function platformKey(entry: ManifestBinding, os: Os): string | undefined {
  const raw =
    os === 'win'
      ? entry.win || entry.linux || entry.key
      : os === 'mac'
        ? entry.mac || entry.key
        : entry.linux || entry.key
  return raw ? canonicalKey(raw, os) : undefined
}

const effective = (os: Os) =>
  pkg.contributes.keybindings.flatMap((entry) => {
    const key = platformKey(entry, os)
    return key ? [{ command: entry.command, key, when: entry.when }] : []
  })

const keysOf = (command: string, os: Os) =>
  effective(os)
    .filter((b) => b.command === command)
    .map((b) => b.key)
    .sort()

const commandsOn = (os: Os, key: string) =>
  effective(os)
    .filter((b) => b.key === key)
    .map((b) => b.command)

const sorted = (keys: readonly string[]) => [...keys].sort()

// Win/Linux share VMDE's `key`; macOS has its own. Each entry lists the keys per platform family.
interface KeyPair {
  winLinux: readonly string[]
  mac: readonly string[]
}
const expectedKeys = (pair: KeyPair, os: Os) =>
  sorted(
    (os === 'mac' ? pair.mac : pair.winLinux).map((k) => canonicalKey(k, os)),
  )

interface BoundRow {
  command: string
  title: string
  keys: KeyPair
  when: string
  /** The VS Code command whose default key this row mirrors; absent for the Owner conventions. */
  mirror?: string
  redUntil?: { contributed?: Step; keys?: Step; when?: Step }
}

const BOUND: readonly BoundRow[] = [
  // CP3-1 flips the `when` rows: existing bindings gain G1.
  {
    command: 'vmde.format.bold',
    title: 'Format: Bold',
    keys: { winLinux: ['ctrl+b'], mac: ['cmd+b'] },
    when: G1,
    redUntil: { when: 'CP3-1' },
  },
  {
    command: 'vmde.format.italic',
    title: 'Format: Italic',
    keys: { winLinux: ['ctrl+i'], mac: ['cmd+i'] },
    when: G1,
    redUntil: { when: 'CP3-1' },
  },
  {
    command: 'vmde.format.indent',
    title: 'Format: Indent',
    keys: { winLinux: ['ctrl+]'], mac: ['cmd+]'] },
    when: G1,
    mirror: 'editor.action.indentLines',
    redUntil: { when: 'CP3-1' },
  },
  {
    command: 'vmde.format.outdent',
    title: 'Format: Outdent',
    keys: { winLinux: ['ctrl+['], mac: ['cmd+['] },
    when: G1,
    mirror: 'editor.action.outdentLines',
    redUntil: { when: 'CP3-1' },
  },
  // CP2-3: Undo/Redo are retitled and bound to VS Code's keys.
  {
    command: 'vmde.format.undo',
    title: 'Undo',
    keys: { winLinux: ['ctrl+z'], mac: ['cmd+z'] },
    when: G1,
    mirror: 'undo',
  },
  {
    command: 'vmde.format.redo',
    title: 'Redo',
    keys: { winLinux: ['ctrl+y', 'ctrl+shift+z'], mac: ['cmd+shift+z'] },
    when: G1,
    mirror: 'redo',
  },
  // CP2-6 flips: Select All and Expand Selection become commands.
  {
    command: 'vmde.selectAll',
    title: 'Select All',
    keys: { winLinux: ['ctrl+a'], mac: ['cmd+a'] },
    when: G1,
    mirror: 'editor.action.selectAll',
    redUntil: { contributed: 'CP2-6', keys: 'CP2-6', when: 'CP2-6' },
  },
  {
    command: 'vmde.expandSelection',
    title: 'Expand Selection',
    keys: {
      winLinux: ['shift+alt+right'],
      mac: ['ctrl+shift+cmd+right', 'ctrl+shift+right'],
    },
    when: G1,
    mirror: 'editor.action.smartSelect.expand',
    redUntil: { contributed: 'CP2-6', keys: 'CP2-6', when: 'CP2-6' },
  },
  // CP2-5: Move Block Up/Down become commands on VS Code's Move Line Up/Down keys.
  {
    command: 'vmde.moveBlockUp',
    title: 'Move Block Up',
    keys: { winLinux: ['alt+up'], mac: ['alt+up'] },
    when: G1,
    mirror: 'editor.action.moveLinesUpAction',
  },
  {
    command: 'vmde.moveBlockDown',
    title: 'Move Block Down',
    keys: { winLinux: ['alt+down'], mac: ['alt+down'] },
    when: G1,
    mirror: 'editor.action.moveLinesDownAction',
  },
  // CP2-4: Fold, Unfold and Toggle Fold take VS Code's keys and titles.
  {
    command: 'vmde.fold',
    title: 'Fold',
    keys: { winLinux: ['ctrl+shift+['], mac: ['cmd+alt+['] },
    when: G1,
    mirror: 'editor.fold',
  },
  {
    command: 'vmde.unfold',
    title: 'Unfold',
    keys: { winLinux: ['ctrl+shift+]'], mac: ['cmd+alt+]'] },
    when: G1,
    mirror: 'editor.unfold',
  },
  {
    command: 'vmde.toggleSectionFold',
    title: 'Toggle Fold',
    keys: { winLinux: ['ctrl+k ctrl+l'], mac: ['cmd+k cmd+l'] },
    when: G1,
    mirror: 'editor.toggleFold',
  },
  // CP3-1 flips the `when` rows: Task 579's Find bindings gain G1 and keep their widget predicate.
  {
    command: 'vmde.find',
    title: 'Find',
    keys: { winLinux: ['ctrl+f'], mac: ['cmd+f'] },
    when: G1,
    mirror: 'actions.find',
    redUntil: { when: 'CP3-1' },
  },
  {
    command: 'vmde.findReplace',
    title: 'Replace',
    keys: { winLinux: ['ctrl+h'], mac: ['cmd+alt+f'] },
    when: G1,
    mirror: 'editor.action.startFindReplaceAction',
    redUntil: { when: 'CP3-1' },
  },
  {
    command: 'vmde.findNext',
    title: 'Find Next',
    keys: { winLinux: ['f3'], mac: ['f3', 'cmd+g'] },
    when: G1_FIND,
    mirror: 'editor.action.nextMatchFindAction',
    redUntil: { when: 'CP3-1' },
  },
  {
    command: 'vmde.findPrevious',
    title: 'Find Previous',
    keys: { winLinux: ['shift+f3'], mac: ['shift+f3', 'cmd+shift+g'] },
    when: G1_FIND,
    mirror: 'editor.action.previousMatchFindAction',
    redUntil: { when: 'CP3-1' },
  },
  {
    command: 'vmde.toggleFindCaseSensitive',
    title: 'Toggle Find Case Sensitive',
    keys: { winLinux: ['alt+c'], mac: ['cmd+alt+c'] },
    when: G1_FIND,
    mirror: 'toggleFindCaseSensitive',
    redUntil: { when: 'CP3-1' },
  },
  {
    command: 'vmde.toggleFindWholeWord',
    title: 'Toggle Find Whole Word',
    keys: { winLinux: ['alt+w'], mac: ['cmd+alt+w'] },
    when: G1_FIND,
    mirror: 'toggleFindWholeWord',
    redUntil: { when: 'CP3-1' },
  },
  {
    command: 'vmde.replaceOne',
    title: 'Replace One',
    keys: { winLinux: ['ctrl+shift+1'], mac: ['cmd+shift+1'] },
    when: G1_FIND,
    mirror: 'editor.action.replaceOne',
    redUntil: { when: 'CP3-1' },
  },
  {
    command: 'vmde.replaceAll',
    title: 'Replace All',
    keys: { winLinux: ['ctrl+alt+enter'], mac: ['cmd+alt+enter'] },
    when: G1_FIND,
    mirror: 'editor.action.replaceAll',
    redUntil: { when: 'CP3-1' },
  },
  {
    command: 'vmde.closeFindWidget',
    title: 'Close Find Widget',
    keys: {
      winLinux: ['escape', 'shift+escape'],
      mac: ['escape', 'shift+escape'],
    },
    when: G1_FIND,
    mirror: 'closeFindWidget',
    redUntil: { when: 'CP3-1' },
  },
]

interface UnboundRow {
  command: string
  title: string
  redUntil?: { contributed?: Step; unbound?: Step; palette?: Step }
}

const format = (
  name: string,
  title: string,
  redUntil?: UnboundRow['redUntil'],
): UnboundRow => ({ command: `vmde.format.${name}`, title, redUntil })
const table = (name: string, title: string): UnboundRow => ({
  command: `vmde.table.${name}`,
  title: `Table: ${title}`,
  redUntil: { contributed: 'CP2-9', palette: 'CP2-9' },
})

const FORMAT_UNBIND: UnboundRow['redUntil'] = {
  unbound: 'CP3-1',
  palette: 'CP3-1',
}

const UNBOUND: readonly UnboundRow[] = [
  // CP3-1 flips: the eight formatting rows lose their keys and get a VMDE-gated palette entry.
  format('strike', 'Format: Strikethrough', FORMAT_UNBIND),
  format('headings', 'Format: Headings', FORMAT_UNBIND),
  format('list', 'Format: Bulleted List', FORMAT_UNBIND),
  format('orderedList', 'Format: Numbered List', FORMAT_UNBIND),
  format('check', 'Format: Checklist', FORMAT_UNBIND),
  format('quote', 'Format: Blockquote', FORMAT_UNBIND),
  format('code', 'Format: Code Block', FORMAT_UNBIND),
  format('inlineCode', 'Format: Inline Code', FORMAT_UNBIND),
  // CP2-7 flips: Rewrap loses Alt+Q.
  {
    command: 'vmde.rewrap',
    title: 'Rewrap Paragraph/Selection',
    redUntil: { unbound: 'CP2-7' },
  },
  { command: 'vmde.rewrapDocument', title: 'Rewrap Document' },
  // CP3-1 flips: Paste as Plain Text loses Ctrl/Cmd+Shift+V.
  {
    command: 'vmde.pastePlain',
    title: 'Paste as Plain Text',
    redUntil: { unbound: 'CP3-1', palette: 'CP3-1' },
  },
  // CP2-8 flips: link activation and Edit in Text Editor lose Ctrl/Cmd+Enter and Ctrl+Alt+E.
  {
    command: 'vmde.activateLinkAtCaret',
    title: 'Activate Link or Callout at Caret',
    redUntil: { unbound: 'CP2-8', palette: 'CP2-8' },
  },
  {
    command: 'vmde.openTextEditor',
    title: 'Edit in Text Editor',
    redUntil: { unbound: 'CP2-8', palette: 'CP2-8' },
  },
  { command: 'vmde.formatTable', title: 'Format table' },
  { command: 'vmde.turnInto', title: 'Turn Into...' },
  { command: 'vmde.fixListNumbering', title: 'Fix List Numbering' },
  { command: 'vmde.renormalizeAllLists', title: 'Renormalize All Lists' },
  { command: 'vmde.promoteHeading', title: 'Promote Heading Level' },
  { command: 'vmde.demoteHeading', title: 'Demote Heading Level' },
  // CP2-7 flips: the heading-section commands are new.
  {
    command: 'vmde.promoteHeadingSection',
    title: 'Promote Heading Section',
    redUntil: { contributed: 'CP2-7', palette: 'CP2-7' },
  },
  {
    command: 'vmde.demoteHeadingSection',
    title: 'Demote Heading Section',
    redUntil: { contributed: 'CP2-7', palette: 'CP2-7' },
  },
  // CP2-9 flips: the 13 table commands are new.
  table('alignLeft', 'Align Left'),
  table('alignCenter', 'Align Center'),
  table('alignRight', 'Align Right'),
  table('insertRowAbove', 'Insert Row Above'),
  table('insertRowBelow', 'Insert Row Below'),
  table('insertColumnLeft', 'Insert Column Left'),
  table('insertColumnRight', 'Insert Column Right'),
  table('deleteRow', 'Delete Row'),
  table('deleteColumn', 'Delete Column'),
  table('moveColumnLeft', 'Move Column Left'),
  table('moveColumnRight', 'Move Column Right'),
  table('moveRowUp', 'Move Row Up'),
  table('moveRowDown', 'Move Row Down'),
  // CP2-10 flips: headings 1-6, the edit-mode switches and the task checkbox are new.
  ...[1, 2, 3, 4, 5, 6].map((level) =>
    format(`heading${level}`, `Format: Heading ${level}`, {
      contributed: 'CP2-10',
      palette: 'CP2-10',
    }),
  ),
  {
    command: 'vmde.switchToWysiwyg',
    title: 'Switch to WYSIWYG Mode',
    redUntil: { contributed: 'CP2-10', palette: 'CP2-10' },
  },
  {
    command: 'vmde.switchToInstantRendering',
    title: 'Switch to Instant Rendering Mode',
    redUntil: { contributed: 'CP2-10', palette: 'CP2-10' },
  },
  {
    command: 'vmde.switchToSplitView',
    title: 'Switch to Split View Mode',
    redUntil: { contributed: 'CP2-10', palette: 'CP2-10' },
  },
  {
    command: 'vmde.toggleTaskCheckbox',
    title: 'Toggle Task Checkbox',
    redUntil: { contributed: 'CP2-10', palette: 'CP2-10' },
  },
]

// Former keys (inventory and target table) that no VMDE binding may keep. Win/Linux keys are
// checked on both platforms. The step is the one that removes today's manifest binding.
const FREED_WIN_LINUX: readonly [string, Step?][] = [
  ['alt+q', 'CP2-7'],
  ['ctrl+shift+v', 'CP3-1'],
  ['ctrl+enter', 'CP2-8'],
  ['ctrl+alt+e', 'CP2-8'],
  ['ctrl+alt+['],
  ['ctrl+d', 'CP3-1'],
  ['ctrl+l', 'CP3-1'],
  ['ctrl+shift+7', 'CP3-1'],
  ['ctrl+shift+9', 'CP3-1'],
  ['ctrl+;', 'CP3-1'],
  ['ctrl+u', 'CP3-1'],
  ['ctrl+g', 'CP3-1'],
  ['ctrl+e'],
  ['ctrl+shift+alt+['],
  ['ctrl+shift+alt+]'],
  ['ctrl+='],
  ['ctrl+-'],
  ['ctrl+shift+f'],
  ['ctrl+shift+g'],
  ['ctrl+shift+='],
  ['ctrl+shift+-'],
  ['ctrl+shift+l'],
  ['ctrl+shift+c'],
  ['ctrl+shift+r'],
  ['ctrl+shift+pageup'],
  ['ctrl+shift+pagedown'],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): [string] => [`ctrl+alt+${n}`]),
  ['ctrl+shift+j'],
  ['ctrl+shift+;'],
  ['ctrl+shift+u'],
  ['ctrl+shift+d'],
  ['ctrl+shift+x'],
]
const FREED_MAC: readonly [string, Step?][] = [
  ['alt+q', 'CP2-7'],
  ['cmd+shift+v', 'CP3-1'],
  ['cmd+enter', 'CP2-8'],
  ['cmd+ctrl+e', 'CP2-8'],
  ['cmd+h', 'CP3-1'],
  ['cmd+d', 'CP3-1'],
  ['cmd+l', 'CP3-1'],
  ['cmd+shift+7', 'CP3-1'],
  ['cmd+shift+9', 'CP3-1'],
  ['cmd+;', 'CP3-1'],
  ['cmd+u', 'CP3-1'],
  ['cmd+e'],
  ['cmd+y'],
  ['cmd+shift+['],
  ['cmd+shift+]'],
  ['cmd+alt+shift+['],
  ['cmd+alt+shift+]'],
  ['cmd+='],
  ['cmd+-'],
  ['cmd+shift+f'],
  ['cmd+shift+='],
  ['cmd+shift+-'],
  ['cmd+shift+l'],
  ['cmd+shift+c'],
  ['cmd+shift+r'],
  ['cmd+shift+pageup'],
  ['cmd+shift+pagedown'],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): [string] => [`cmd+alt+${n}`]),
  ['cmd+shift+j'],
  ['cmd+shift+;'],
  ['cmd+shift+u'],
  ['cmd+shift+d'],
  ['cmd+shift+x'],
]

function itContributed(command: string, title: string, step?: Step) {
  itUntil(step)(
    `${command} is contributed as "${title}" (category VMDE)`,
    () => {
      expect(
        pkg.contributes.commands.find((c) => c.command === command),
      ).toMatchObject({ title, category: 'VMDE' })
    },
  )
}

describe('Task 580 bound commands: VS Code keys per platform under G1', () => {
  for (const row of BOUND) {
    itContributed(row.command, row.title, row.redUntil?.contributed)

    itUntil(row.redUntil?.keys)(
      `${row.command} has exactly its target key on Windows, Linux and macOS`,
      () => {
        for (const os of OSES) {
          expect(keysOf(row.command, os), `${row.command} on ${os}`).toEqual(
            expectedKeys(row.keys, os),
          )
        }
      },
    )

    itUntil(row.redUntil?.when)(
      `${row.command} binds only under ${row.when === G1 ? 'G1' : 'G1 && vmde.findWidgetVisible'}`,
      () => {
        const entries = pkg.contributes.keybindings.filter(
          (b) => b.command === row.command,
        )
        expect(
          entries.length,
          `${row.command} has no keybinding`,
        ).toBeGreaterThan(0)
        for (const entry of entries) expect(entry.when).toBe(row.when)
      },
    )

    if (row.mirror) {
      const mirror = row.mirror
      it(`${row.command} target keys equal the pinned defaults of ${mirror}`, () => {
        expect(fixture.mirrors[row.command]?.command).toBe(mirror)
        for (const os of OSES) {
          expect(sorted(fixture.mirrors[row.command].keys[os]), os).toEqual(
            expectedKeys(row.keys, os),
          )
        }
      })
    }
  }
})

describe('Task 580 unbound commands: contributed, no default key, palette gated to VMDE', () => {
  for (const row of UNBOUND) {
    itContributed(row.command, row.title, row.redUntil?.contributed)

    itUntil(row.redUntil?.unbound)(
      `${row.command} has no default keybinding on any platform`,
      () => {
        for (const os of OSES) {
          expect(keysOf(row.command, os), `${row.command} on ${os}`).toEqual([])
        }
      },
    )

    itUntil(row.redUntil?.palette)(
      `${row.command} appears in the Command Palette only while VMDE is active`,
      () => {
        const entry = pkg.contributes.menus.commandPalette.find(
          (p) => p.command === row.command,
        )
        expect(entry?.when?.split(' && ') ?? [], row.command).toContain(
          VMDE_ACTIVE,
        )
      },
    )
  }

  it('the target table has 22 bound and 44 unbound commands, none listed twice', () => {
    const all = [...BOUND, ...UNBOUND].map((r) => r.command)
    expect(BOUND).toHaveLength(22)
    expect(UNBOUND).toHaveLength(44)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('Task 580 freed keys: no VMDE binding remains', () => {
  for (const [key, step] of FREED_WIN_LINUX) {
    itUntil(step)(`Windows/Linux ${key} has no VMDE binding`, () => {
      for (const os of ['win', 'linux'] as const) {
        expect(commandsOn(os, canonicalKey(key, os)), os).toEqual([])
      }
    })
  }
  for (const [key, step] of FREED_MAC) {
    itUntil(step)(`macOS ${key} has no VMDE binding`, () => {
      expect(commandsOn('mac', canonicalKey(key, 'mac'))).toEqual([])
    })
  }

  it('Windows/Linux Ctrl+H runs only Replace', () => {
    for (const os of ['win', 'linux'] as const) {
      expect(commandsOn(os, 'ctrl+h'), os).toEqual(['vmde.findReplace'])
    }
  })

  // CP3-1 flips: Inline Code gives up macOS Cmd+G to Find Next.
  it.fails('macOS Cmd+G runs only Find Next (while the Find widget is visible)', () => {
    expect(commandsOn('mac', 'cmd+g')).toEqual(['vmde.findNext'])
  })
})

describe('Task 580 manifest equals the target keymap', () => {
  const target = (os: Os) =>
    BOUND.flatMap((row) =>
      expectedKeys(row.keys, os).map((key) => `${key} -> ${row.command}`),
    ).sort()
  for (const os of OSES) {
    // CP3-1 flips: the last step that brings package.json to the target table.
    it.fails(`${os} keybindings are exactly the target table`, () => {
      expect(
        effective(os)
          .map((b) => `${b.key} -> ${b.command}`)
          .sort(),
      ).toEqual(target(os))
    })
  }
})

// Policy 5: where a VMDE default meets a VS Code default for a different function under an
// overlapping `when`, the VS Code function wins. A VMDE command that sits on its mirror's own
// default key inherits VS Code's identity, including whatever VS Code itself co-binds there; any
// other VMDE binding may share a key only with bindings that cannot hold in the VMDE webview, or
// with an Owner-sanctioned convention collision (fixture `sanctionedCollisions`).
describe('Task 580 collisions with VS Code defaults (pinned 1.129.0)', () => {
  const bindingsOn = (os: Os, key: string) =>
    fixture.bindings.filter((b) => b.keys[os].includes(key))

  function collisions(os: Os, key: string): string[] {
    return commandsOn(os, key).flatMap((command) => {
      if (fixture.mirrors[command]?.keys[os].includes(key)) return []
      return bindingsOn(os, key)
        .filter((b) => b.canHoldInVmdeWebview)
        .filter(
          (b) =>
            !fixture.sanctionedCollisions.some(
              (s) => s.vmdeCommand === command && s.vscodeCommand === b.command,
            ),
        )
        .map((b) => `${command} vs ${b.command} (when: ${b.when ?? '—'})`)
    })
  }

  const boundOrTarget = (os: Os) =>
    Object.entries(fixture.keyRoles[os])
      .filter(
        ([, roles]) => roles.includes('current') || roles.includes('target'),
      )
      .map(([key]) => key)

  // Current manifest bindings that take a key from a VS Code function able to run in the webview.
  const COLLIDING_NOW: Record<string, Step> = {
    'ctrl+g': 'CP3-1', // Inline Code vs workbench.action.gotoLine
    'ctrl+enter': 'CP2-8', // Activate Link vs terminal-chat run commands
    'cmd+enter': 'CP2-8', // Activate Link vs terminal-chat run commands
  }

  const winLinuxKeys = [
    ...new Set([...boundOrTarget('win'), ...boundOrTarget('linux')]),
  ]
  for (const key of winLinuxKeys) {
    itUntil(COLLIDING_NOW[key])(
      `Windows/Linux ${key} takes no VS Code function`,
      () => {
        for (const os of ['win', 'linux'] as const) {
          expect(collisions(os, key), os).toEqual([])
        }
      },
    )
  }
  for (const key of boundOrTarget('mac')) {
    itUntil(COLLIDING_NOW[key])(
      `macOS ${key} takes no VS Code function`,
      () => {
        expect(collisions('mac', key)).toEqual([])
      },
    )
  }

  it('Bold and Italic collide only with their sanctioned VS Code bindings', () => {
    for (const os of OSES) {
      const bold = os === 'mac' ? 'cmd+b' : 'ctrl+b'
      const italic = os === 'mac' ? 'cmd+i' : 'ctrl+i'
      const holders = (key: string) =>
        bindingsOn(os, key)
          .filter((b) => b.canHoldInVmdeWebview)
          .map((b) => b.command)
      expect(holders(bold), os).toEqual([
        'workbench.action.toggleSidebarVisibility',
      ])
      expect(holders(italic), os).toEqual([
        'workbench.action.chat.holdToVoiceChatInChatView',
      ])
    }
  })

  // A key bound before Task 580 is a `current` fixture key; a key a conversion step has already
  // moved to its target binding is a `target` fixture key. Both are collision-checked above.
  it('every key VMDE binds today is covered by the fixture', () => {
    for (const os of OSES) {
      for (const { key } of effective(os)) {
        expect(
          fixture.keyRoles[os][key]?.some(
            (role) => role === 'current' || role === 'target',
          ),
          `${os} ${key}`,
        ).toBe(true)
      }
    }
  })

  it('every target key is covered by the fixture', () => {
    for (const os of OSES) {
      for (const row of BOUND) {
        for (const key of expectedKeys(row.keys, os)) {
          expect(fixture.keyRoles[os][key], `${os} ${key}`).toContain('target')
        }
      }
    }
  })

  // The fixture derived these from the full dump and bundle scan; VMDE must leave them free too.
  it('candidate free remap keys have no VMDE binding', () => {
    for (const os of OSES) {
      expect(fixture.candidateFreeRemapKeys[os].length, os).toBeGreaterThan(0)
      for (const key of fixture.candidateFreeRemapKeys[os]) {
        expect(commandsOn(os, key), `${os} ${key}`).toEqual([])
      }
    }
  })

  it('records the pinned VS Code version and dump provenance', () => {
    expect(fixture.provenance.vscodeVersion).toBe('1.129.0')
    expect(fixture.provenance.linuxDump).toContain(
      'default-keybindings-linux-1.129.0.jsonc',
    )
  })
})
