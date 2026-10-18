import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { createToolbar } from '../src/chrome/toolbar'
import { ensureToolbarRows } from '../src/chrome/toolbar-layout'
import {
  installToolbarCollapse,
  receiveToolbarCollapsed,
} from '../src/chrome/toolbar-collapse'
import { installToolbarMenuPosition } from '../src/chrome/toolbar-menu-position'
import { installToolbarOverflow } from '../src/chrome/toolbar-overflow'
import { installToolbarRowHover } from '../src/chrome/toolbar-row-hover'
import { installToolbarSubmenuAria } from '../src/chrome/toolbar-submenu-aria'
import { installEmojiPicker } from '../src/editing/emoji-picker'
import { configureEmojiInsertion } from '../src/editing/emoji-insertion'
import {
  configureNamedAnchorInsertion,
  installNamedAnchorInsertion,
} from '../src/editing/named-anchor-insertion'
import {
  installEscapeToolbar,
  refreshToolbarRoving,
} from '../src/editing/escape-toolbar'
import { installStructuralSelection } from '../src/editing/selection-scope'
import {
  installUndoBoundaries,
  preparePendingHistory,
} from '../src/editing/undo-boundaries'
import { installVditorHistoryCoupling } from '../src/editing/undo-keybind'

const wikiEnabled =
  new URLSearchParams(location.search).get('wiki') === 'enabled'

// Task 631 F2: the host sends the shared collapsed state with the init payload, before the toolbar
// is built. `?collapsed=1` plays that init; `__receiveToolbarCollapsed` plays a later state message,
// and `__toolbarPosts` records what the toggle posts to the host.
const toolbarPosts: unknown[] = []
;(window as any).__toolbarPosts = toolbarPosts
;(window as any).__receiveToolbarCollapsed = receiveToolbarCollapsed
receiveToolbarCollapsed(
  new URLSearchParams(location.search).get('collapsed') === '1',
)

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value: 'toolbar overflow',
  toolbar: createToolbar({ wikiEnabled }),
  toolbarConfig: { pin: true },
  // The product sets an input callback, which arms the edit's pending checkpoint that Undo and Redo
  // settle first; the harness records what it would publish to the host.
  input: (markdown: string) => void (window as any).__published?.push(markdown),
  after() {
    ;(window as any).vditor = editor
    const toolbar = editor.vditor.toolbar.element as HTMLElement
    // Same wiring order as boot/finish-init.ts: the keydown dispatcher (which owns arrow/Home/End
    // inside the more menu) first, then the overflow shell that feeds it.
    ensureToolbarRows(toolbar)
    installEscapeToolbar()
    installStructuralSelection()
    // Same order as boot/finish-init.ts: the collapse toggle applies the shared state before overflow measures.
    installToolbarCollapse(toolbar, {
      postMessage: (message) => void toolbarPosts.push(message),
    })
    installToolbarOverflow(toolbar, refreshToolbarRoving)
    installToolbarSubmenuAria(toolbar)
    configureEmojiInsertion({
      snapshotMarkdown: () => editor.getValue(),
      session: () => editor.vditor,
      writable: () =>
        editor.vditor.currentMode !== undefined &&
        editor.vditor[editor.vditor.currentMode].element.getAttribute(
          'contenteditable',
        ) !== 'false',
      setApplying: () => undefined,
      syncExact: (markdown) => void markdown,
      onError: (error) => {
        throw error
      },
    })
    installEmojiPicker(toolbar)
    installToolbarMenuPosition(toolbar)
    installToolbarRowHover(toolbar)
    configureNamedAnchorInsertion({
      setApplying: (applying) => void applying,
      postExact: (markdown) => void markdown,
      onError: (error) => {
        throw error
      },
    })
    installNamedAnchorInsertion()
    // The toolbar click takes the same undo boundary as in the product, so a toolbar insertion's
    // Undo and Redo steps can be checked here.
    installUndoBoundaries(editor, window)
    // The history engine posts a transition to the host on every Undo and Redo; record them.
    ;(window as any).__published = []
    ;(window as any).__transitions = []
    installVditorHistoryCoupling(
      window,
      (message) => (window as any).__transitions.push(message),
      preparePendingHistory,
    )
    ;(window as any).__ready = true
  },
})
