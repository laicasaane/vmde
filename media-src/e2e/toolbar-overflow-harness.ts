import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { createToolbar } from '../src/chrome/toolbar'
import { ensureToolbarRows } from '../src/chrome/toolbar-layout'
import { installToolbarMenuPosition } from '../src/chrome/toolbar-menu-position'
import { installToolbarOverflow } from '../src/chrome/toolbar-overflow'
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

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value: 'toolbar overflow',
  toolbar: createToolbar(),
  toolbarConfig: { pin: true },
  after() {
    ;(window as any).vditor = editor
    const toolbar = editor.vditor.toolbar.element as HTMLElement
    // Same wiring order as boot/finish-init.ts: the keydown dispatcher (which owns arrow/Home/End
    // inside the more menu) first, then the overflow shell that feeds it.
    ensureToolbarRows(toolbar)
    installEscapeToolbar()
    installStructuralSelection()
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
    configureNamedAnchorInsertion({
      setApplying: (applying) => void applying,
      postExact: (markdown) => void markdown,
      onError: (error) => {
        throw error
      },
    })
    installNamedAnchorInsertion()
    ;(window as any).__ready = true
  },
})
