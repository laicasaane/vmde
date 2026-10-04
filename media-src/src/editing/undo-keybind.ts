// Undo/redo history coupling.
//
// Task 580 CP2-3 moved keyboard Undo/Redo out of the webview. Ctrl/Cmd+Z, Ctrl+Y and
// Ctrl/Cmd+Shift+Z are now VS Code keybindings of `vmde.format.undo`/`redo` under G1
// (package.json, checked against src/shared/editor-shortcuts.ts). The flow per press:
//   1. the keydown passes VMDE's own listeners untouched;
//   2. VS Code's webview preload calls `preventDefault` (blocking native contenteditable undo)
//      and forwards the key, from whichever webview element has focus;
//   3. the VMDE binding (extension weight) beats core `undo`/`redo`, so only one command runs;
//   4. the host posts `trigger-toolbar-hotkey` and message-router.ts calls the engine once.
// This keeps Task 463's measured requirements: one engine call per press, VS Code's native
// undo never also fires, Ctrl/Cmd+Shift+Z redoes, and the key works with focus outside the
// editable root in all three modes. macOS Cmd+Y no longer redoes (VS Code has no such default).
//
// The file keeps its name because Task 601 hooks `installVditorHistoryCoupling` here.

import { clearTableCellSelections } from './table-cell-selection'

type HistoryKind = 'undo' | 'redo'

type HistoryPost = (message: {
  command: 'history-transition'
  kind: HistoryKind
  before: string
  after: string
}) => void

const HISTORY_COUPLED = Symbol('vmde-history-coupled')

/** Wrap the one shared Vditor history engine so keyboard, toolbar, and command actions all couple. */
export function installVditorHistoryCoupling(
  win: any,
  post: HistoryPost = (message) => win.vscode?.postMessage(message),
): void {
  const outer = win?.vditor
  const undo = outer?.vditor?.undo
  if (!outer || !undo || undo[HISTORY_COUPLED]) return
  undo[HISTORY_COUPLED] = true
  for (const kind of ['undo', 'redo'] as const) {
    const original = undo[kind].bind(undo)
    undo[kind] = (inner: unknown) => {
      // A fake table-cell rectangle names cells of the pre-transition DOM; drop it on every
      // undo/redo path (command, toolbar button) rather than on the Z/Y keys.
      clearTableCellSelections()
      const before = outer.getValue()
      const result = original(inner)
      const after = outer.getValue()
      if (before !== after) {
        post({ command: 'history-transition', kind, before, after })
      }
      return result
    }
  }
}
