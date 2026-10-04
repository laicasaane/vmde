// Task 580 — the shared shortcut table: one row per command in the Checkpoint 1 "Final target
// table" of tasks/580-rectify-shortcuts-vscode-identity.md (22 bound and 44 unbound commands).
// Cross-tree like `protocol.ts`: the host imports it directly and the webview and its test shim
// reach across the tree (`../../src/shared/editor-shortcuts`).
//
// Checkpoint 3 (CP3-1) makes it the single owner of every VMDE shortcut. Everything else derives
// from these rows:
//   - `src/app/commands.ts` registers each row whose route is a panel message;
//   - `package.json` `contributes.commands`, `keybindings` and `menus.commandPalette` must equal
//     `contributedKeybindings()` and `commandPaletteWhen()` (a static JSON manifest cannot import
//     this module, so `test/backend/format-hotkeys.test.ts` asserts it);
//   - the webview's `trigger-toolbar-hotkey` whitelist (`TOOLBAR_COMMAND_NAMES`) and the formatting
//     toolbar tooltips (`toolbarTip`);
//   - the Chromium keybinding shim (`media-src/e2e/keybinding-shim.ts`).
//
// Keys use VS Code's keybinding notation (`ctrl+shift+[`, `cmd+k cmd+l`). Windows and Linux share
// one key list, as every target row does.
import type { EditorAction, FindWidgetAction, HostMessage } from './protocol'

/** A VMDE editor is the active editor (the Command Palette gate of every table command). */
const VMDE_ACTIVE_WHEN = 'activeCustomEditorId == vmde.editor'

/** The `when` clause for every contributed VMDE binding (G1 in the task record). */
export const VMDE_SHORTCUT_WHEN = `${VMDE_ACTIVE_WHEN} && !inputFocus && !sideBarFocus && !panelFocus && !auxiliaryBarFocus`

/** G1 plus the Find widget's own visibility context key, for the Find-widget-only commands. */
export const VMDE_FIND_WIDGET_WHEN = `${VMDE_SHORTCUT_WHEN} && vmde.findWidgetVisible`

type ShortcutIdentity =
  /** Ships the default key of this VS Code command. */
  | { kind: 'mirror'; vscodeCommand: string }
  /** Bold and Italic: the Owner's Markdown-editor convention keys. */
  | { kind: 'convention' }
  /** No VS Code equivalent: unbound by default. */
  | { kind: 'vmde-only' }

interface ShortcutKeys {
  winLinux: readonly string[]
  mac: readonly string[]
}

/** The host→webview message a command posts to the active VMDE panel. */
export type PanelRoute = Extract<
  HostMessage,
  {
    command:
      | 'trigger-toolbar-hotkey'
      | 'editor-action'
      | 'open-find-replace'
      | 'find-widget-action'
      | 'toggle-section-fold'
      | 'shift-heading-level'
      | 'rewrap-selection'
      | 'prepare-rewrap-document'
      | 'activate-link-at-caret'
      | 'format-table'
      | 'request-block-transform-options'
      | 'fix-list-numbering'
      | 'renormalize-all-lists'
  }
>

interface ShortcutBase {
  command: string
  title: string
  identity: ShortcutIdentity
  /** `host` marks a command whose work happens in the extension host (clipboard, text editor). */
  route: PanelRoute | 'host'
}

export type EditorShortcut = ShortcutBase &
  ({ keys: ShortcutKeys; when: string } | { keys: 'unbound'; when?: undefined })

const mirror = (vscodeCommand: string): ShortcutIdentity => ({
  kind: 'mirror',
  vscodeCommand,
})
const CONVENTION: ShortcutIdentity = { kind: 'convention' }
const VMDE_ONLY: ShortcutIdentity = { kind: 'vmde-only' }

const toolbar = (name: string): PanelRoute => ({
  command: 'trigger-toolbar-hotkey',
  name,
})
const editorAction = (action: EditorAction): PanelRoute => ({
  command: 'editor-action',
  action,
})
const findAction = (action: FindWidgetAction): PanelRoute => ({
  command: 'find-widget-action',
  action,
})
const headingShift = (direction: -1 | 1, section: boolean): PanelRoute => ({
  command: 'shift-heading-level',
  direction,
  section,
})

const same = (keys: readonly string[]): ShortcutKeys => ({
  winLinux: keys,
  mac: keys,
})

function bound(
  command: string,
  title: string,
  identity: ShortcutIdentity,
  keys: ShortcutKeys,
  route: PanelRoute,
  when = VMDE_SHORTCUT_WHEN,
): EditorShortcut {
  return { command, title, identity, keys, when, route }
}

function unbound(
  command: string,
  title: string,
  route: PanelRoute | 'host',
): EditorShortcut {
  return { command, title, identity: VMDE_ONLY, keys: 'unbound', route }
}

function findWidget(
  command: string,
  title: string,
  vscodeCommand: string,
  keys: ShortcutKeys,
  action: FindWidgetAction,
): EditorShortcut {
  return bound(
    command,
    title,
    mirror(vscodeCommand),
    keys,
    findAction(action),
    VMDE_FIND_WIDGET_WHEN,
  )
}

const BOUND_SHORTCUTS: readonly EditorShortcut[] = [
  bound(
    'vmde.format.bold',
    'Format: Bold',
    CONVENTION,
    { winLinux: ['ctrl+b'], mac: ['cmd+b'] },
    toolbar('bold'),
  ),
  bound(
    'vmde.format.italic',
    'Format: Italic',
    CONVENTION,
    { winLinux: ['ctrl+i'], mac: ['cmd+i'] },
    toolbar('italic'),
  ),
  bound(
    'vmde.format.indent',
    'Format: Indent',
    mirror('editor.action.indentLines'),
    { winLinux: ['ctrl+]'], mac: ['cmd+]'] },
    toolbar('indent'),
  ),
  bound(
    'vmde.format.outdent',
    'Format: Outdent',
    mirror('editor.action.outdentLines'),
    { winLinux: ['ctrl+['], mac: ['cmd+['] },
    toolbar('outdent'),
  ),
  bound(
    'vmde.format.undo',
    'Undo',
    mirror('undo'),
    { winLinux: ['ctrl+z'], mac: ['cmd+z'] },
    toolbar('undo'),
  ),
  bound(
    'vmde.format.redo',
    'Redo',
    mirror('redo'),
    { winLinux: ['ctrl+y', 'ctrl+shift+z'], mac: ['cmd+shift+z'] },
    toolbar('redo'),
  ),
  bound(
    'vmde.selectAll',
    'Select All',
    mirror('editor.action.selectAll'),
    { winLinux: ['ctrl+a'], mac: ['cmd+a'] },
    editorAction('select-all'),
  ),
  bound(
    'vmde.expandSelection',
    'Expand Selection',
    mirror('editor.action.smartSelect.expand'),
    {
      winLinux: ['shift+alt+right'],
      mac: ['ctrl+shift+cmd+right', 'ctrl+shift+right'],
    },
    editorAction('expand-selection'),
  ),
  bound(
    'vmde.moveBlockUp',
    'Move Block Up',
    mirror('editor.action.moveLinesUpAction'),
    same(['alt+up']),
    editorAction('move-block-up'),
  ),
  bound(
    'vmde.moveBlockDown',
    'Move Block Down',
    mirror('editor.action.moveLinesDownAction'),
    same(['alt+down']),
    editorAction('move-block-down'),
  ),
  bound(
    'vmde.fold',
    'Fold',
    mirror('editor.fold'),
    { winLinux: ['ctrl+shift+['], mac: ['cmd+alt+['] },
    editorAction('fold'),
  ),
  bound(
    'vmde.unfold',
    'Unfold',
    mirror('editor.unfold'),
    { winLinux: ['ctrl+shift+]'], mac: ['cmd+alt+]'] },
    editorAction('unfold'),
  ),
  bound(
    'vmde.toggleSectionFold',
    'Toggle Fold',
    mirror('editor.toggleFold'),
    { winLinux: ['ctrl+k ctrl+l'], mac: ['cmd+k cmd+l'] },
    { command: 'toggle-section-fold' },
  ),
  bound(
    'vmde.find',
    'Find',
    mirror('actions.find'),
    { winLinux: ['ctrl+f'], mac: ['cmd+f'] },
    { command: 'open-find-replace', mode: 'find' },
  ),
  bound(
    'vmde.findReplace',
    'Replace',
    mirror('editor.action.startFindReplaceAction'),
    { winLinux: ['ctrl+h'], mac: ['cmd+alt+f'] },
    { command: 'open-find-replace', mode: 'replace' },
  ),
  findWidget(
    'vmde.findNext',
    'Find Next',
    'editor.action.nextMatchFindAction',
    { winLinux: ['f3'], mac: ['f3', 'cmd+g'] },
    'next',
  ),
  findWidget(
    'vmde.findPrevious',
    'Find Previous',
    'editor.action.previousMatchFindAction',
    { winLinux: ['shift+f3'], mac: ['shift+f3', 'cmd+shift+g'] },
    'previous',
  ),
  findWidget(
    'vmde.toggleFindCaseSensitive',
    'Toggle Find Case Sensitive',
    'toggleFindCaseSensitive',
    { winLinux: ['alt+c'], mac: ['cmd+alt+c'] },
    'toggle-case',
  ),
  findWidget(
    'vmde.toggleFindWholeWord',
    'Toggle Find Whole Word',
    'toggleFindWholeWord',
    { winLinux: ['alt+w'], mac: ['cmd+alt+w'] },
    'toggle-whole-word',
  ),
  findWidget(
    'vmde.replaceOne',
    'Replace One',
    'editor.action.replaceOne',
    { winLinux: ['ctrl+shift+1'], mac: ['cmd+shift+1'] },
    'replace-one',
  ),
  findWidget(
    'vmde.replaceAll',
    'Replace All',
    'editor.action.replaceAll',
    { winLinux: ['ctrl+alt+enter'], mac: ['cmd+alt+enter'] },
    'replace-all',
  ),
  findWidget(
    'vmde.closeFindWidget',
    'Close Find Widget',
    'closeFindWidget',
    same(['escape', 'shift+escape']),
    'close',
  ),
]

const TABLE_ACTIONS: readonly [string, string, EditorAction][] = [
  ['alignLeft', 'Align Left', 'table-align-left'],
  ['alignCenter', 'Align Center', 'table-align-center'],
  ['alignRight', 'Align Right', 'table-align-right'],
  ['insertRowAbove', 'Insert Row Above', 'table-insert-row-above'],
  ['insertRowBelow', 'Insert Row Below', 'table-insert-row-below'],
  ['insertColumnLeft', 'Insert Column Left', 'table-insert-column-left'],
  ['insertColumnRight', 'Insert Column Right', 'table-insert-column-right'],
  ['deleteRow', 'Delete Row', 'table-delete-row'],
  ['deleteColumn', 'Delete Column', 'table-delete-column'],
  ['moveColumnLeft', 'Move Column Left', 'table-move-column-left'],
  ['moveColumnRight', 'Move Column Right', 'table-move-column-right'],
  ['moveRowUp', 'Move Row Up', 'table-move-row-up'],
  ['moveRowDown', 'Move Row Down', 'table-move-row-down'],
]

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const

const UNBOUND_SHORTCUTS: readonly EditorShortcut[] = [
  unbound('vmde.format.strike', 'Format: Strikethrough', toolbar('strike')),
  unbound('vmde.format.headings', 'Format: Headings', toolbar('headings')),
  unbound('vmde.format.list', 'Format: Bulleted List', toolbar('list')),
  unbound(
    'vmde.format.orderedList',
    'Format: Numbered List',
    toolbar('ordered-list'),
  ),
  unbound('vmde.format.check', 'Format: Checklist', toolbar('check')),
  unbound('vmde.format.quote', 'Format: Blockquote', toolbar('quote')),
  unbound('vmde.format.code', 'Format: Code Block', toolbar('code')),
  unbound(
    'vmde.format.inlineCode',
    'Format: Inline Code',
    toolbar('inline-code'),
  ),
  unbound('vmde.rewrap', 'Rewrap Paragraph/Selection', {
    command: 'rewrap-selection',
  }),
  unbound('vmde.rewrapDocument', 'Rewrap Document', {
    command: 'prepare-rewrap-document',
  }),
  // The host reads the clipboard, then posts `paste-plain` with the text.
  unbound('vmde.pastePlain', 'Paste as Plain Text', 'host'),
  unbound('vmde.activateLinkAtCaret', 'Activate Link or Callout at Caret', {
    command: 'activate-link-at-caret',
  }),
  // The host opens the text editor and reveals the caret's source line.
  unbound('vmde.openTextEditor', 'Edit in Text Editor', 'host'),
  unbound('vmde.formatTable', 'Format table', { command: 'format-table' }),
  unbound('vmde.turnInto', 'Turn Into...', {
    command: 'request-block-transform-options',
  }),
  unbound('vmde.fixListNumbering', 'Fix List Numbering', {
    command: 'fix-list-numbering',
  }),
  unbound('vmde.renormalizeAllLists', 'Renormalize All Lists', {
    command: 'renormalize-all-lists',
  }),
  unbound(
    'vmde.promoteHeading',
    'Promote Heading Level',
    headingShift(-1, false),
  ),
  unbound('vmde.demoteHeading', 'Demote Heading Level', headingShift(1, false)),
  unbound(
    'vmde.promoteHeadingSection',
    'Promote Heading Section',
    headingShift(-1, true),
  ),
  unbound(
    'vmde.demoteHeadingSection',
    'Demote Heading Section',
    headingShift(1, true),
  ),
  ...TABLE_ACTIONS.map(([name, title, action]) =>
    unbound(`vmde.table.${name}`, `Table: ${title}`, editorAction(action)),
  ),
  ...HEADING_LEVELS.map((level) =>
    unbound(
      `vmde.format.heading${level}`,
      `Format: Heading ${level}`,
      editorAction(`heading-${level}`),
    ),
  ),
  unbound(
    'vmde.switchToWysiwyg',
    'Switch to WYSIWYG Mode',
    editorAction('switch-to-wysiwyg'),
  ),
  unbound(
    'vmde.switchToInstantRendering',
    'Switch to Instant Rendering Mode',
    editorAction('switch-to-ir'),
  ),
  unbound(
    'vmde.switchToSplitView',
    'Switch to Split View Mode',
    editorAction('switch-to-sv'),
  ),
  unbound(
    'vmde.toggleTaskCheckbox',
    'Toggle Task Checkbox',
    editorAction('toggle-task-checkbox'),
  ),
]

/** Every Task 580 target-table command: the bound rows first, then the unbound rows. */
export const EDITOR_SHORTCUTS: readonly EditorShortcut[] = [
  ...BOUND_SHORTCUTS,
  ...UNBOUND_SHORTCUTS,
]

const routeCommand = (row: EditorShortcut) =>
  row.route === 'host' ? 'host' : row.route.command

const toolbarRouteName = (row: EditorShortcut) =>
  row.route !== 'host' && row.route.command === 'trigger-toolbar-hotkey'
    ? row.route.name
    : undefined

/** The Command Palette `when` of a table command: a VMDE editor is active and, for the Find-widget
 *  commands, the widget is visible. */
export function commandPaletteWhen(row: EditorShortcut): string {
  return routeCommand(row) === 'find-widget-action'
    ? `${VMDE_ACTIVE_WHEN} && vmde.findWidgetVisible`
    : VMDE_ACTIVE_WHEN
}

/** One `contributes.keybindings` entry, in package.json's field order. */
export interface ContributedKeybinding {
  key: string
  command: string
  mac?: string
  linux?: string
  win?: string
  when: string
}

/** The `contributes.keybindings` entries of one row (none when unbound). VS Code reads `mac`, then
 *  `key` on macOS and `win` or `linux`, then `key` elsewhere, and an empty string falls through
 *  (Part 1 handoff F2): `mac: ''` does not unbind macOS. So the n-th Windows/Linux key and the n-th
 *  macOS key share one entry, and a key that only one platform family has gets an entry with an
 *  empty `key` plus only that family's fields. */
export function contributedKeybindings(
  row: EditorShortcut,
): ContributedKeybinding[] {
  if (row.keys === 'unbound') return []
  const { winLinux, mac } = row.keys
  const entries: ContributedKeybinding[] = []
  for (let i = 0; i < Math.max(winLinux.length, mac.length); i++) {
    const shared = { command: row.command }
    if (winLinux[i] && mac[i])
      entries.push({ key: winLinux[i], ...shared, mac: mac[i], when: row.when })
    else if (mac[i])
      entries.push({ key: '', ...shared, mac: mac[i], when: row.when })
    else
      entries.push({
        key: '',
        ...shared,
        linux: winLinux[i],
        win: winLinux[i],
        when: row.when,
      })
  }
  return entries
}

/** The toolbar item names that a table command clicks through `trigger-toolbar-hotkey`. The webview
 *  drops a message naming any other item (`preview`, `upload`, …). */
export const TOOLBAR_COMMAND_NAMES: ReadonlySet<string> = new Set(
  EDITOR_SHORTCUTS.flatMap((row) => toolbarRouteName(row) ?? []),
)

// `ctrl+shift+7` -> `Ctrl+Shift+7`, `cmd+]` -> `Cmd+]`. A per-segment capitalize is enough for the
// single-chord keys the formatting rows use.
function formatKeyForDisplay(key: string): string {
  return key
    .split('+')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('+')
}

/** The tooltip of a formatting toolbar item that a table command clicks: the command title without
 *  its `Format: ` prefix, then the platform's first default key in parentheses (`Bold (Ctrl+B)`),
 *  or the bare label when the command is unbound. Built from this table, not Vditor's
 *  `updateHotkeyTip`, which only understands its own `⌘`/`⇧` notation. `mac` is a parameter so this
 *  module stays free of `navigator` (the host imports it too). Throws for any other name, so a typo
 *  in the toolbar cannot fall back to Vditor's own hotkey and tooltip. */
export function toolbarTip(name: string, mac: boolean): string {
  const row = EDITOR_SHORTCUTS.find((r) => toolbarRouteName(r) === name)
  if (!row) throw new Error(`"${name}" is not a toolbar command`)
  const label = row.title.replace(/^Format: /, '')
  const key =
    row.keys === 'unbound'
      ? undefined
      : (mac ? row.keys.mac : row.keys.winLinux)[0]
  return key ? `${label} (${formatKeyForDisplay(key)})` : label
}
