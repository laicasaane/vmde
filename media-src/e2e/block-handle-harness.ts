import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import {
  registerEditorActionRunner,
  runEditorAction,
} from '../src/bridge/editor-actions'
import {
  installBlockHandleLayer,
  moveBlockAtCaret,
} from '../src/nav/block-handle'
import { installKeybindingShim } from './keybinding-shim'
import { planBlockAction } from '../../src/shared/block-move'
import { checkpointEditorUndo } from '../src/editing/rewrap-command'

let snapshotRevision: object = {}
let exactSource: string | undefined
// `indexBuilds` is counted by the source index through the opt-in cache-metrics object.
const metrics = { snapshotCalls: 0, getValueCalls: 0, indexBuilds: 0 }
const advanceSnapshotRevision = (): void => {
  snapshotRevision = {}
}

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value: 'alpha\n\n```ts\nconst x = 1\n```\n\nomega\n',
  after() {
    ;(window as any).vditor = editor
    const originalSetValue = editor.setValue.bind(editor)
    const originalGetValue = editor.getValue.bind(editor)
    editor.setValue = (markdown: string) => {
      advanceSnapshotRevision()
      exactSource = markdown
      return originalSetValue(markdown)
    }
    editor.getValue = () => {
      metrics.getValueCalls++
      return originalGetValue()
    }
    ;(window as any).__blockHandleMetrics = metrics
    ;(window as any).__vmdeBlockHandleCacheMetrics = metrics
    ;(window as any).__switchMode = (mode: 'ir' | 'wysiwyg') => {
      const inner = editor.vditor
      if (inner.currentMode === mode) return
      inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
      document
        .querySelector(`button[data-mode="${mode}"]`)
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
    }
    Object.defineProperty(window, '__blockHandleExactInput', {
      configurable: true,
      get: () => exactSource,
      set: (markdown: string | undefined) => {
        exactSource = markdown
        advanceSnapshotRevision()
      },
    })
    const root = () =>
      (editor.vditor.currentMode === 'ir'
        ? editor.vditor.ir.element
        : editor.vditor.wysiwyg.element) as HTMLElement
    const exact = () =>
      (window as any).__blockHandleExactInput ?? editor.getValue()
    // Mirrors EditSync.snapshotPair(): one serializer run supplies both halves of the pair.
    const snapshotPair = () => {
      const rendered = editor.getValue()
      return {
        exact: (window as any).__blockHandleExactInput ?? rendered,
        rendered,
      }
    }
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
      snapshot: () => {
        metrics.snapshotCalls++
        return snapshotPair()
      },
      snapshotRevision: () => snapshotRevision,
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
    // Task 580 CP2-5 — Alt+Up/Down run Move Block Up/Down through the test keybinding shim and
    // the production editor-action dispatcher, the way VS Code resolves the contributed keys.
    registerEditorActionRunner('move-block-up', () => {
      moveBlockAtCaret('up')
    })
    registerEditorActionRunner('move-block-down', () => {
      moveBlockAtCaret('down')
    })
    installKeybindingShim(window, {
      commands: ['vmde.moveBlockUp', 'vmde.moveBlockDown'],
      platform: navigator.platform.toLowerCase().includes('mac')
        ? 'mac'
        : 'win-linux',
      dispatch: (route) => {
        if (route.command === 'editor-action') runEditorAction(route.action)
      },
    })
    ;(window as any).__ready = true
  },
})
