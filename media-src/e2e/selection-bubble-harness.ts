import '../src/boot/preload'
import Vditor from 'vditor/src/index'
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
      snapshotExactMarkdown: () => editor.getValue(),
      onError: (error) => {
        ;(window as any).__selectionBubbleError = String(error)
      },
    })
    ;(window as any).__ready = true
  },
})
