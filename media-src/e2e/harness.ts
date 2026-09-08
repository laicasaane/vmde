import '../src/boot/preload'
import Vditor from 'vditor'
import { fixTableIr } from '../src/editing/fix-table-ir'
import { installTableCellSelection } from '../src/editing/table-cell-selection'
import { configureTableActions } from '../src/editing/table-actions'
import { installTableWysiwygControls } from '../src/editing/table-wysiwyg-controls'
import { fixResponsiveTables } from '../src/chrome/responsive-tables'
import {
  dispatchTableHotkey,
  type TableAction,
} from '../src/editing/table-hotkey'
import { setupCustomRenderer } from '../src/links/custom-renderer'
import * as sourceMap from '../src/util/source-map'
import * as diffMarkers from '../src/chrome/diff-markers'
import { revealSourceLine } from '../src/nav/outline'
import { installCaretWindowBridge } from '../src/editing/caret'
import { checkpointEditorUndo } from '../src/editing/rewrap-command'

installCaretWindowBridge()

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
    ;(window as any).__sourceMap = sourceMap
    ;(window as any).__diffMarkers = diffMarkers
    ;(window as any).__revealSourceLine = (line: number, lineText?: string) =>
      revealSourceLine(editor, line, lineText)
    ;(window as any).__ready = true
  },
})
