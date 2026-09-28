// Task 505 — single source of truth for the promoted Vditor-toolbar formatting hotkeys. Cross-
// tree, same convention as `product-identity.ts` / `protocol.ts`: the host imports it directly
// (`./format-hotkeys`), the webview reaches across the tree (`../../src/shared/format-hotkeys`).
//
// WHY this exists (root cause, see the task file for the full investigation): task 492 Phase 4
// added `contributes.keybindings` entries pointing at `vmde.format.*` commands without touching
// Vditor's OWN hotkey table (`media-src/node_modules/vditor/src/ts/util/Options.ts`), which drives
// three things at once — the toolbar tooltip text, the aria-label, and Vditor's own bubble-phase
// `keydown` handler. Two independent systems reacting to the same keydown is the actual defect;
// keeping two tables "in sync" would still double-fire. The fix is ONE owner per key:
//   - `media-src/src/chrome/toolbar.ts` sets `hotkey: ''` on every row below (this disables
//     Vditor's own dispatch entirely — see `hotKey.ts`'s `matchHotKey`, which returns `false`
//     immediately for an empty hotkey string) and builds the tooltip from `key`/`mac` via
//     `formatTip`, NOT Vditor's own `updateHotkeyTip` (which only understands its `⌘`/`⇧` notation).
//   - `src/app/commands.ts` registers a real VS Code command + reads this table to build
//     `package.json`'s `contributes.keybindings` (package.json itself stays hand-authored — a
//     static JSON manifest can't import a TS module — but a unit test asserts it matches this
//     table exactly, see `test/backend/format-hotkeys.test.ts`).
//
// `key`/`mac` use VS Code's own keybinding notation (`ctrl+shift+7`, `cmd+]`), NOT Vditor's
// `⌘`/`⇧` symbols — they're consumed directly by `package.json` and by `formatTip` below.
export interface FormatHotkey {
  /** Vditor's own item name (`vditor.toolbar.elements` key / `toolbar.ts`'s item `name`). */
  toolbarName: string
  /** The registered VS Code command id. */
  command: string
  /** VS Code win/linux keybinding notation, e.g. `'ctrl+shift+7'`; empty if unbound. */
  key: string
  /** VS Code mac keybinding notation, e.g. `'cmd+shift+7'`. */
  mac: string
  /** Human label for the tooltip, e.g. `'Bold'`. */
  label: string
}

// The 12 promoted formatting hotkeys — 8 kept at Vditor's original key (bold/italic are kept
// regardless of collision, cross-tool convention too strong to break), 4 remapped away from a
// real workbench-command collision (indent/outdent -> Ctrl+[/], ordered-list -> Ctrl+Shift+7,
// check -> Ctrl+Shift+9). Task 579 frees Ctrl+H for Replace, leaving Headings unbound on
// Win/Linux. See task 505 §4 for the original collision-bucket reasoning per row.
export const FORMAT_HOTKEYS: readonly FormatHotkey[] = [
  {
    toolbarName: 'bold',
    command: 'vmde.format.bold',
    key: 'ctrl+b',
    mac: 'cmd+b',
    label: 'Bold',
  },
  {
    toolbarName: 'italic',
    command: 'vmde.format.italic',
    key: 'ctrl+i',
    mac: 'cmd+i',
    label: 'Italic',
  },
  {
    toolbarName: 'strike',
    command: 'vmde.format.strike',
    key: 'ctrl+d',
    mac: 'cmd+d',
    label: 'Strikethrough',
  },
  {
    toolbarName: 'headings',
    command: 'vmde.format.headings',
    key: '',
    mac: 'cmd+h',
    label: 'Headings',
  },
  {
    toolbarName: 'list',
    command: 'vmde.format.list',
    key: 'ctrl+l',
    mac: 'cmd+l',
    label: 'Bulleted List',
  },
  {
    toolbarName: 'ordered-list',
    command: 'vmde.format.orderedList',
    key: 'ctrl+shift+7',
    mac: 'cmd+shift+7',
    label: 'Numbered List',
  },
  {
    toolbarName: 'check',
    command: 'vmde.format.check',
    key: 'ctrl+shift+9',
    mac: 'cmd+shift+9',
    label: 'Checklist',
  },
  {
    toolbarName: 'outdent',
    command: 'vmde.format.outdent',
    key: 'ctrl+[',
    mac: 'cmd+[',
    label: 'Outdent',
  },
  {
    toolbarName: 'indent',
    command: 'vmde.format.indent',
    key: 'ctrl+]',
    mac: 'cmd+]',
    label: 'Indent',
  },
  {
    toolbarName: 'quote',
    command: 'vmde.format.quote',
    key: 'ctrl+;',
    mac: 'cmd+;',
    label: 'Blockquote',
  },
  {
    toolbarName: 'code',
    command: 'vmde.format.code',
    key: 'ctrl+u',
    mac: 'cmd+u',
    label: 'Code Block',
  },
  {
    toolbarName: 'inline-code',
    command: 'vmde.format.inlineCode',
    key: 'ctrl+g',
    mac: 'cmd+g',
    label: 'Inline Code',
  },
]

// Undo/redo keep their `vmde.format.*` commands (Command Palette discoverability), but get NO
// `contributes.keybindings` entry: `media-src/src/editing/undo-keybind.ts` (task 463) already owns
// Ctrl/Cmd+Z, +Y, +Shift+Z from anywhere in the webview — a formal keybinding on top of it would
// just be a second actor racing the first (see task 505 §3). Not part of FORMAT_HOTKEYS since they
// carry no key/mac.
export const UNBOUND_FORMAT_COMMANDS: readonly {
  command: string
  toolbarName: string
}[] = [
  { command: 'vmde.format.undo', toolbarName: 'undo' },
  { command: 'vmde.format.redo', toolbarName: 'redo' },
]

// `ctrl+shift+7` -> `Ctrl+Shift+7`, `cmd+]` -> `Cmd+]`, `ctrl+;` -> `Ctrl+;`. Simple per-segment
// capitalize, not a general keybinding formatter — sufficient for the notation `FORMAT_HOTKEYS`
// itself uses (single modifiers + a single trailing symbol/letter/digit).
function formatKeyForDisplay(key: string): string {
  return key
    .split('+')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('+')
}

// Builds the toolbar tooltip text for a promoted item: `"${label} (${Ctrl+Shift+7 | Cmd+Shift+7})"`
// depending on platform. Deliberately built from this table's own `key`/`mac` fields, NOT Vditor's
// `updateHotkeyTip` (which only understands `⌘`/`⇧`) — see the module header. `mac` is a parameter
// rather than computed here so this module stays free of `navigator`/DOM (it's imported by the
// host tree too). An unbound platform gets only the bare label.
export function formatTip(
  label: string,
  mac: boolean,
  row: Pick<FormatHotkey, 'key' | 'mac'>,
): string {
  const key = mac ? row.mac : row.key
  return key ? `${label} (${formatKeyForDisplay(key)})` : label
}
