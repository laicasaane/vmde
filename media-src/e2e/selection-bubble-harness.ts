import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { setEditMode } from 'vditor/src/ts/toolbar/EditMode'
import { installCaretInvalidation } from '../src/editing/caret'
import {
  applyBlockTransformChoice,
  configureBlockTransformCommand,
} from '../src/editing/block-transform-command'
import { installSelectionBubble } from '../src/editing/selection-bubble'
import {
  currentBlockProjection,
  resolveBlockHandleUnits,
} from '../src/nav/block-handle'
import { createSourceBlockIndex } from '../src/nav/source-block-index'

// Mirrors finish-init: setValue advances the source revision the shared index keys on.
let revision: object = {}
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
    ;(window as any).__applyBubbleChoice = (request: {
      token: number
      target: { type: string }
      status: string
    }) =>
      applyBlockTransformChoice(
        window,
        request.token,
        request.target as never,
        request.status === 'confirm-required',
      )
    const originalSetValue = editor.setValue.bind(editor)
    editor.setValue = (markdown: string, clearStack?: boolean) => {
      revision = {}
      return originalSetValue(markdown, clearStack)
    }
    // The shared index follows the active root/mode through the same projection the block
    // handle and Details controls use, so `setEditMode` (the harness's mode switch) is visible.
    const activeRoot = (): HTMLElement | null => {
      const inner = editor.vditor
      if (inner.currentMode === 'ir') return inner.ir.element
      if (inner.currentMode === 'wysiwyg') return inner.wysiwyg.element
      return null
    }
    // Same opt-in counters finish-init and the source index use in the real webview, so the
    // performance spec can assert index-build/snapshot counts against this harness too.
    const cacheMetrics = { blockHandleSnapshotCalls: 0, indexBuilds: 0 }
    ;(window as any).__vmdeBlockHandleCacheMetrics = cacheMetrics
    // Uncounted: the bubble takes this directly (Task 574 Checkpoint 6), same as finish-init.
    const snapshotPair = () => {
      const rendered = editor.getValue()
      return { exact: rendered, rendered }
    }
    const sourceIndex = createSourceBlockIndex({
      getActiveRoot: activeRoot,
      projection: currentBlockProjection,
      // The index build itself is the only counted consumer of this pair in this harness.
      snapshotPair: () => {
        cacheMetrics.blockHandleSnapshotCalls++
        return snapshotPair()
      },
      snapshotRevision: () => revision,
      resolveUnits: (root, exact, rendered) =>
        resolveBlockHandleUnits(
          root,
          exact,
          rendered,
          currentBlockProjection(),
        ),
    })
    installSelectionBubble({
      enabled: true,
      wikiEnabled: true,
      setApplying: () => undefined,
      postExact: (markdown) => {
        ;(window as any).__selectionBubbleExact = markdown
      },
      snapshotExactMarkdown: () => editor.getValue(),
      snapshotPair,
      index: sourceIndex,
      onError: (error) => {
        ;(window as any).__selectionBubbleError = String(error)
      },
    })
    ;(window as any).__ready = true
  },
})
