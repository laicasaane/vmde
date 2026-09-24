import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { installBlockHandleLayer } from '../src/nav/block-handle'
import { planBlockAction } from '../../src/shared/block-move'
import { checkpointEditorUndo } from '../src/editing/rewrap-command'

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value: 'alpha\n\n```ts\nconst x = 1\n```\n\nomega\n',
  after() {
    ;(window as any).vditor = editor
    const root = () => editor.vditor.ir.element as HTMLElement
    const exact = () =>
      (window as any).__blockHandleExactInput ?? editor.getValue()
    const apply = (result: { status: string; markdown?: string }) => {
      if (result.status !== 'ok' || !result.markdown) return
      const inner = editor.vditor
      checkpointEditorUndo(inner)
      editor.setValue(result.markdown)
      ;(window as any).__blockHandleExactInput = result.markdown
      checkpointEditorUndo(inner)
      ;(window as any).__blockHandlePosts =
        ((window as any).__blockHandlePosts ?? 0) + 1
      ;(window as any).__blockHandleExact = result.markdown
    }
    ;(window as any).__blockHandlePosts = 0
    ;(window as any).__blockHandleTurnInto = null
    installBlockHandleLayer(root, {
      snapshot: () => ({ exact: exact(), rendered: editor.getValue() }),
      move: (sourceStart, targetStart, placement) =>
        apply(
          planBlockAction(exact(), {
            kind: 'move',
            sourceStart,
            targetStart,
            placement,
          }),
        ),
      delete: (sourceStart) => {
        ;(window as any).__blockHandleLastAction = {
          kind: 'delete',
          sourceStart,
        }
        apply(planBlockAction(exact(), { kind: 'delete', sourceStart }))
      },
      duplicate: (sourceStart) => {
        ;(window as any).__blockHandleLastAction = {
          kind: 'duplicate',
          sourceStart,
        }
        apply(planBlockAction(exact(), { kind: 'duplicate', sourceStart }))
      },
      turnInto: (source) => {
        ;(window as any).__blockHandleTurnInto = source
      },
    })
    ;(window as any).__ready = true
  },
})
