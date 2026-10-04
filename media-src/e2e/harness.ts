import '../src/boot/preload'
import Vditor from 'vditor'
import { fixTableIr } from '../src/editing/fix-table-ir'
import { installTableCellSelection } from '../src/editing/table-cell-selection'
import { configureTableActions } from '../src/editing/table-actions'
import { installTableWysiwygControls } from '../src/editing/table-wysiwyg-controls'
import { fixResponsiveTables } from '../src/chrome/responsive-tables'
import { installTableColumnResize } from '../src/chrome/table-resize'
import {
  dispatchTableHotkey,
  runTableCommand,
  TABLE_EDITOR_ACTIONS,
  type TableAction,
} from '../src/editing/table-hotkey'
import {
  registerEditorActionRunner,
  runEditorAction,
} from '../src/bridge/editor-actions'
import { installKeybindingShim } from './keybinding-shim'
import { setupCustomRenderer } from '../src/links/custom-renderer'
import * as sourceMap from '../src/util/source-map'
import * as diffMarkers from '../src/chrome/diff-markers'
import { revealSourceLine } from '../src/nav/outline'
import { installCaretWindowBridge } from '../src/editing/caret'
import { checkpointEditorUndo } from '../src/editing/rewrap-command'

installCaretWindowBridge()

// Task 580 CP2-9 — the harness's user keys for the unbound table commands (table-hotkey.spec.ts
// presses them).
const TABLE_USER_KEYS: Readonly<Record<string, string>> = {
  'alt+shift+l': 'vmde.table.alignLeft',
  'alt+shift+c': 'vmde.table.alignCenter',
  'alt+shift+r': 'vmde.table.alignRight',
  'alt+shift+f': 'vmde.table.insertRowAbove',
  'alt+shift+b': 'vmde.table.insertRowBelow',
  'alt+shift+g': 'vmde.table.insertColumnLeft',
  'alt+shift+h': 'vmde.table.insertColumnRight',
  'alt+shift+d': 'vmde.table.deleteRow',
  'alt+shift+e': 'vmde.table.deleteColumn',
  'alt+shift+1': 'vmde.table.moveColumnLeft',
  'alt+shift+2': 'vmde.table.moveColumnRight',
  'alt+shift+3': 'vmde.table.moveRowUp',
  'alt+shift+4': 'vmde.table.moveRowDown',
}

// Minimal page that instantiates Vditor in IR mode with a known table and
// wires fix-table-ir, mirroring how main.ts sets things up. Exposed globals
// let the Playwright test drive and read the editor.
const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value: '| Header One | Header Two |\n| - | - |\n| value one | value two |\n',
  after() {
    ;(window as any).vditor = editor
    ;(window as any).vditorTest = editor
    setupCustomRenderer(editor, { enabled: false })
    fixTableIr()
    fixResponsiveTables()
    installTableColumnResize()
    installTableCellSelection(editor.vditor.ir.element)
    installTableCellSelection(editor.vditor.wysiwyg.element)
    installTableWysiwygControls()
    configureTableActions({
      snapshotExactMarkdown: () => editor.getValue(),
      setApplying: () => undefined,
      postExact: () => undefined,
      onError: (error) => {
        if (
          error instanceof Error &&
          error.message === 'Task 219 injected second checkpoint failure'
        )
          return
        throw error
      },
      checkpointUndo: (inner) => {
        const test = window as any
        test.__tableCheckpointCount = (test.__tableCheckpointCount ?? 0) + 1
        if (
          test.__tableFailSecondCheckpoint &&
          test.__tableCheckpointCount % 2 === 0
        ) {
          test.__tableFailSecondCheckpoint = false
          throw new Error('Task 219 injected second checkpoint failure')
        }
        checkpointEditorUndo(inner)
      },
    })
    const isMac = navigator.platform.toLowerCase().includes('mac')
    ;(window as any).__dispatchTableHotkey = (type: TableAction) =>
      dispatchTableHotkey(editor.vditor.ir.element, type, isMac)
    // Task 580 CP2-9 — the 13 table commands are unbound. Register their runners as main.ts does
    // and give each a user key (Alt+Shift+…, which no Vditor chord matches) through the
    // keybinding shim, which runs the `editor-action` route through the real dispatcher.
    for (const [action, command] of TABLE_EDITOR_ACTIONS)
      registerEditorActionRunner(action, () => {
        runTableCommand(command)
      })
    installKeybindingShim(window, {
      commands: Object.values(TABLE_USER_KEYS),
      userKeys: TABLE_USER_KEYS,
      platform: isMac ? 'mac' : 'win-linux',
      dispatch: (route) => {
        if (route.command === 'editor-action') runEditorAction(route.action)
      },
    })
    ;(window as any).__sourceMap = sourceMap
    ;(window as any).__diffMarkers = diffMarkers
    ;(window as any).__revealSourceLine = (line: number, lineText?: string) =>
      revealSourceLine(editor, line, lineText)
    ;(window as any).__ready = true
  },
})
