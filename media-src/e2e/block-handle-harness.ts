import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { installBlockHandleLayer } from '../src/nav/block-handle'
import { planBlockDelete, planBlockDuplicate, planBlockMove } from '../../src/shared/block-move'
import { checkpointEditorUndo } from '../src/editing/rewrap-command'

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value: 'alpha\n\n```ts\nconst x = 1\n```\n\nomega\n',
  after() {
    ;(window as any).vditor = editor
    const root = () => editor.vditor.ir.element as HTMLElement
    const exact = () => editor.getValue()
    const apply = (result: { status: string; markdown?: string }) => {
      if (result.status !== 'ok' || !result.markdown) return
      const inner = editor.vditor
      checkpointEditorUndo(inner)
      editor.setValue(result.markdown)
      checkpointEditorUndo(inner)
      ;(window as any).__blockHandlePosts = ((window as any).__blockHandlePosts ?? 0) + 1
      ;(window as any).__blockHandleExact = result.markdown
    }
    ;(window as any).__blockHandlePosts = 0
    ;(window as any).__blockHandleTurnInto = null
    installBlockHandleLayer(root, {
      snapshot: () => ({ exact: exact(), rendered: editor.getValue() }),
      move: (source, target, placement) => apply(planBlockMove(exact(), source, target, placement)),
      delete: (source) => apply(planBlockDelete(exact(), source)),
      duplicate: (source) => apply(planBlockDuplicate(exact(), source)),
      turnInto: (source) => { (window as any).__blockHandleTurnInto = source },
    })
    ;(window as any).__ready = true
  },
})
