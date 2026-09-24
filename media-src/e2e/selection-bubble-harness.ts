import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { setEditMode } from 'vditor/src/ts/toolbar/EditMode'
import { installCaretInvalidation } from '../src/editing/caret'
import { configureBlockTransformCommand } from '../src/editing/block-transform-command'
import { installSelectionBubble } from '../src/editing/selection-bubble'

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  toolbar: [],
  cdn: `${location.origin}/vditor`,
  value: 'alpha\n\nbeta\n',
  after() {
    ;(window as any).vditor = editor
    ;(window as any).__setSelectionBubbleMode = (mode: string) =>
      setEditMode(editor.vditor as never, mode, editor.getValue())
    installCaretInvalidation()
    configureBlockTransformCommand({
      snapshotExactMarkdown: () => editor.getValue(),
      setApplying: () => undefined,
      postExact: (markdown) => {
        ;(window as any).__selectionBubbleExact = markdown
      },
      onError: (error) => {
        ;(window as any).__selectionBubbleError = String(error)
      },
    })
    installSelectionBubble({
      enabled: true,
      wikiEnabled: true,
      setApplying: () => undefined,
      postExact: (markdown) => {
        ;(window as any).__selectionBubbleExact = markdown
      },
      snapshotExactMarkdown: () => editor.getValue(),
      onError: (error) => {
        ;(window as any).__selectionBubbleError = String(error)
      },
    })
    ;(window as any).__ready = true
  },
})
