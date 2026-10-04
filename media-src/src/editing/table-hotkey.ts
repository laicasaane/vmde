import type { EditorAction } from '../../../src/shared/protocol'
import { innerVditor } from '../util/inner-vditor'
import { isMac } from '../util/platform'
import { activeModeElement } from '../util/source-map'
import { runTableMove } from './table-actions'
import type { TableMove } from './table-operations'

export type TableAction =
  | 'left'
  | 'center'
  | 'right'
  | 'insertRowA'
  | 'insertRowB'
  | 'insertColumnL'
  | 'insertColumnR'
  | 'deleteRow'
  | 'deleteColumn'

type ShortcutDef = { key: string; shift: boolean; macKey?: string }

// Faithful 1:1 mapping of the former user-event handleMap. `macKey` captures
// the cases where the mac variant uses a different character than non-mac.
const SHORTCUTS: Record<TableAction, ShortcutDef> = {
  left: { key: 'l', shift: true },
  center: { key: 'c', shift: true },
  right: { key: 'r', shift: true },
  insertRowA: { key: 'f', shift: true },
  insertRowB: { key: '=', shift: false },
  deleteRow: { key: '-', shift: false },
  insertColumnL: { key: 'g', shift: true },
  insertColumnR: { key: '+', macKey: '=', shift: true },
  deleteColumn: { key: '_', macKey: '-', shift: true },
}

function resolveShortcut(
  type: TableAction,
  isMac: boolean,
): { key: string; shift: boolean } {
  const def = SHORTCUTS[type]
  return { key: isMac && def.macKey ? def.macKey : def.key, shift: def.shift }
}

/**
 * Task 580 CP2-9 — the synthetic-chord helper (Part 1 handoff §2.6). Dispatches one untrusted
 * keydown on a Vditor mode element and stops it on that element, in bubble phase, after Vditor's
 * own listener there (registered when Vditor was built, so it runs first). The event never
 * bubbles to the document or window, where VS Code's webview preload would forward it to the
 * workbench as a keypress: both 1.110.0 and 1.129.0 forward untrusted keys and only a stopped
 * propagation blocks them (CP1 P2). Window and document capture listeners still see it first.
 * Returns whether a listener before the containment handled the chord (`defaultPrevented`).
 * Task 580 CP2-10 reuses it for the heading, edit-mode and task chords (vditor-chord-actions.ts).
 */
export function dispatchContainedKeydown(
  el: HTMLElement,
  init: KeyboardEventInit,
): boolean {
  const event = new KeyboardEvent('keydown', {
    ...init,
    bubbles: true,
    cancelable: true,
  })
  let handled = false
  const contain = (seen: Event) => {
    if (seen !== event) return
    handled = seen.defaultPrevented
    seen.preventDefault()
    seen.stopPropagation()
  }
  el.addEventListener('keydown', contain)
  try {
    el.dispatchEvent(event)
  } finally {
    el.removeEventListener('keydown', contain)
  }
  return handled
}

// Vditor matches these hotkeys on keydown via event.key + modifiers
// (isCtrl = ctrlKey || metaKey), so dispatching a KeyboardEvent on the mode
// element is enough to trigger the table action. The event is untrusted, so it
// still matches now that Task 580 CP2-10 makes Vditor ignore its trusted chords.
export function dispatchTableHotkey(
  el: HTMLElement,
  type: TableAction,
  isMac: boolean,
): boolean {
  const { key, shift } = resolveShortcut(type, isMac)
  return dispatchContainedKeydown(el, {
    key,
    shiftKey: shift,
    ctrlKey: !isMac,
    metaKey: isMac,
  })
}

export type TableCommand = TableAction | TableMove

/** Task 580 CP2-9 — the 13 unbound `vmde.table.*` editor actions and the table command each runs. */
export const TABLE_EDITOR_ACTIONS: readonly (readonly [
  EditorAction,
  TableCommand,
])[] = [
  ['table-align-left', 'left'],
  ['table-align-center', 'center'],
  ['table-align-right', 'right'],
  ['table-insert-row-above', 'insertRowA'],
  ['table-insert-row-below', 'insertRowB'],
  ['table-insert-column-left', 'insertColumnL'],
  ['table-insert-column-right', 'insertColumnR'],
  ['table-delete-row', 'deleteRow'],
  ['table-delete-column', 'deleteColumn'],
  ['table-move-column-left', 'moveColumnLeft'],
  ['table-move-column-right', 'moveColumnRight'],
  ['table-move-row-up', 'moveRowUp'],
  ['table-move-row-down', 'moveRowDown'],
]

function isTableMove(command: TableCommand): command is TableMove {
  return command.startsWith('move')
}

/**
 * Task 580 CP2-9 — run one table command at the caret, as its former chord did: the four moves
 * through the exact-source table transaction, the rest as Vditor's own table chord sent through
 * the contained synthetic helper. IR and WYSIWYG only; Split View has no table cells to act on.
 * Returns whether the command ran.
 */
export function runTableCommand(command: TableCommand): boolean {
  const inner = innerVditor()
  if (inner?.currentMode !== 'ir' && inner?.currentMode !== 'wysiwyg')
    return false
  const root = window.vditor ? activeModeElement(window.vditor) : null
  const node = document.getSelection()?.anchorNode
  const element = node instanceof Element ? node : node?.parentElement
  const cell = element?.closest('td,th')
  if (!root || !cell || !root.contains(cell)) return false
  if (isTableMove(command)) return runTableMove(command)
  // The editor-action dispatcher already took this action's undo boundary (undo-boundaries.ts
  // EDITOR_ACTION_UNDO_BOUNDARIES). Since CP2-10 no table chord is a key boundary, so the keydown
  // listener cannot take a second one.
  return dispatchTableHotkey(root, command, isMac())
}
