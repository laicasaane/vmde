import Vditor from 'vditor/src/index'
import { setEditMode } from 'vditor/src/ts/toolbar/EditMode'
import {
  installCaretInvalidation,
  installCaretWindowBridge,
  invalidateCaret,
} from '../src/editing/caret'
import { createPendingEdit } from '../src/bridge/pending-edit'
import {
  flushPendingEditorRespin,
  installEditActivity,
} from '../src/editing/edit-activity'
import {
  installUndoBoundaries,
  preparePendingHistory,
} from '../src/editing/undo-boundaries'
import { installVditorHistoryCoupling } from '../src/editing/undo-keybind'
import { installUndoRestoreCaret } from '../src/editing/undo-restore-caret'
import { installCompositionState } from '../src/util/caret-gesture'

// Vditor is built from SOURCE here, so the build's undo/index.ts patches apply (Tasks 445/487/553,
// 597 and 598). The webview bridges are installed in boot/main.ts order before the editor exists:
// the composition authority, caret invalidation, the caret authority bridge and the Task 597
// restore fallback.
installCompositionState()
installCaretInvalidation()
installCaretWindowBridge()
installUndoRestoreCaret()

type Mode = 'ir' | 'wysiwyg' | 'sv'

// Task 598: `mode` and `doc` select the first-edit case. Nothing here waits for, clears or seeds
// the history: the first-edit specs observe Vditor's natural empty stacks at ready.
const params = new URLSearchParams(location.search)
const mode = (params.get('mode') ?? 'ir') as Mode
const DOCS: Record<string, string> = {
  empty: '',
  para: 'Alpha bravo charlie\n',
  two: 'Alpha bravo charlie\n\nDelta echo foxtrot\n',
  delta: 'Alpha bravo delta.\n',
}
const value = DOCS[params.get('doc') ?? 'empty'] ?? ''

// Task 601: `real=1` adds the production pieces between an edit and the host: the edit-activity
// gate (the IR prose path defers its spin to a 220 ms settle), a 250 ms debounced publication sink
// standing in for edit-sync, and the shared history wrapper. `__host()` models VS Code's native
// history: every published edit is one undo group, and a history transition moves one group.
const real = params.get('real') === '1'
type Post =
  | { command: 'edit'; content: string }
  | {
      command: 'history-transition'
      kind: 'undo' | 'redo'
      before: string
      after: string
    }
const posts: Post[] = []
const host = { text: '', undo: [] as string[], redo: [] as string[] }
const publish = () => {
  const content = editor.getValue()
  posts.push({ command: 'edit', content })
  if (content === host.text) return
  host.undo.push(host.text)
  host.redo = []
  host.text = content
}
const sink = createPendingEdit({ wait: 250, onIdle: publish, onFlush: publish })
const flushHistoryInput = () => {
  if (!sink.pending) return false
  sink.flush()
  return true
}
const postHistory = (message: Post) => {
  posts.push(message)
  if (message.command !== 'history-transition') return
  const [from, to] =
    message.kind === 'undo' ? [host.undo, host.redo] : [host.redo, host.undo]
  const next = from.pop()
  if (next === undefined) return
  to.push(host.text)
  host.text = next
}

// Every source the editor publishes through `options.input`, for "a seed publishes nothing".
const inputs: string[] = []
// Each call of the Task 598 seed, recorded by a read-only wrapper: result and the stack depths
// it saw. The wrapper does not change timers, history, source or selection.
const seeds: { result: boolean; undo: number; redo: number; mode: Mode }[] = []

const editor = new Vditor('app', {
  cache: { enable: false },
  mode,
  height: 320,
  cdn: `${location.origin}/vditor`,
  value,
  undoDelay: 800,
  toolbar: ['bold', 'undo', 'redo'],
  customWysiwygToolbar: () => {
    /* Vditor calls this while constructing WYSIWYG controls. */
  },
  input(markdown: string) {
    inputs.push(markdown)
    if (real) sink.schedule()
  },
  after() {
    ;(window as any).vditor = editor
    host.text = editor.getValue()
    if (real) {
      installEditActivity(document.getElementById('app'))
      // As boot/finish-init.ts wires them.
      installUndoBoundaries(editor, window, {
        flushHistoryInput,
        flushRespin: flushPendingEditorRespin,
      })
      installVditorHistoryCoupling(window, postHistory, preparePendingHistory)
    } else {
      installUndoBoundaries(editor)
    }
    const inner = (editor as unknown as { vditor: IVditor }).vditor
    const undo = inner.undo as any
    const root = () => inner[inner.currentMode].element as HTMLElement
    // Calls of addToUndoStack (from any timer or boundary), to observe a cancelled render timer.
    let addCalls = 0
    const addToUndoStack = undo.addToUndoStack.bind(undo)
    undo.addToUndoStack = (vditor: IVditor) => {
      addCalls += 1
      return addToUndoStack(vditor)
    }
    ;(window as any).__addCalls = () => addCalls
    if (typeof undo.vmdeSeedBaseline === 'function') {
      const seed = undo.vmdeSeedBaseline.bind(undo)
      undo.vmdeSeedBaseline = (vditor: IVditor, event?: Event) => {
        const state = undo[vditor.currentMode]
        const before = {
          undo: state.undoStack.length,
          redo: state.redoStack.length,
          mode: vditor.currentMode as Mode,
        }
        const result = seed(vditor, event)
        seeds.push({ result, ...before })
        return result
      }
    }
    const focusEnd = () => {
      const el = root()
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    }
    const textOffset = (node: Node, offset: number) => {
      const range = document.createRange()
      range.selectNodeContents(root())
      range.setEnd(node, offset)
      return range.toString().length
    }
    ;(window as any).__focusEnd = focusEnd
    ;(window as any).__value = () => editor.getValue()
    // As the Undo/Redo route in bridge/message-router.ts: drop a caret request still live from the
    // last checkpoint (Task 597) before the engine restores the caret.
    ;(window as any).__undo = () => {
      invalidateCaret()
      inner.undo.undo(inner)
    }
    ;(window as any).__redo = () => {
      invalidateCaret()
      inner.undo.redo(inner)
    }
    ;(window as any).__mode = () => inner.currentMode
    ;(window as any).__stack = () => ({
      undo: undo[inner.currentMode].undoStack.length,
      redo: undo[inner.currentMode].redoStack.length,
    })
    ;(window as any).__stacks = () =>
      Object.fromEntries(
        (['ir', 'wysiwyg', 'sv'] as const).map((m) => [
          m,
          { undo: undo[m].undoStack.length, redo: undo[m].redoStack.length },
        ]),
      )
    ;(window as any).__lastText = () => undo[inner.currentMode].lastText
    ;(window as any).__inputs = () => inputs.slice()
    ;(window as any).__posts = () => posts.slice()
    ;(window as any).__host = () => host.text
    ;(window as any).__sinkPending = () => sink.pending
    ;(window as any).__seeds = () => seeds.slice()
    ;(window as any).__seedMethod = () =>
      typeof undo.vmdeSeedBaseline === 'function'
    // The method-level contract: the Vditor method itself, not the VMDE wrapper.
    ;(window as any).__seedDirect = () =>
      typeof undo.vmdeSeedBaseline === 'function'
        ? undo.vmdeSeedBaseline(inner)
        : 'missing'
    ;(window as any).__pendingTimer = () =>
      inner.currentMode === 'wysiwyg'
        ? inner.wysiwyg.afterRenderTimeoutId
        : inner[inner.currentMode].processTimeoutId
    // Method-contract setup only: put one placeholder entry on a stack of the active mode.
    ;(window as any).__pushPlaceholder = (stack: 'undoStack' | 'redoStack') => {
      undo[inner.currentMode][stack].push([])
    }
    ;(window as any).__markerInDom = () =>
      !!root().querySelector('wbr, .vditor-wbr')
    ;(window as any).__toolbarDisabled = (name: string) =>
      !!inner.toolbar.elements[name]?.children[0]?.classList.contains(
        'vditor-menu--disabled',
      )
    ;(window as any).__switchMode = (next: Mode) =>
      setEditMode(inner, next, new Event('click'))
    // The selection as logical text offsets in the active root, with its direction.
    ;(window as any).__selection = () => {
      const selection = getSelection()!
      if (
        !selection.rangeCount ||
        !selection.anchorNode ||
        !selection.focusNode
      )
        return null
      if (!root().contains(selection.anchorNode)) return null
      return {
        anchor: textOffset(selection.anchorNode, selection.anchorOffset),
        focus: textOffset(selection.focusNode, selection.focusOffset),
        text: selection.toString(),
      }
    }
    ;(window as any).__paste = (text: string, atEnd = true) => {
      if (atEnd) focusEnd()
      const data = new DataTransfer()
      data.setData('text/plain', text)
      return root().dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      )
    }
    // Vditor's own cut route (editorCommonEvent cutEvent): its listener copies and then runs
    // `execCommand("delete")`, which emits no `beforeinput`.
    ;(window as any).__cut = () =>
      root().dispatchEvent(
        new ClipboardEvent('cut', {
          clipboardData: new DataTransfer(),
          bubbles: true,
          cancelable: true,
        }),
      )
    // An external HTML drop: Vditor's drop listener routes it through its paste insertion.
    ;(window as any).__dropHtml = (html: string) => {
      const data = new DataTransfer()
      data.setData('text/html', html)
      data.setData('text/plain', html.replace(/<[^>]+>/g, ''))
      return root().dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
        }),
      )
    }
    // Focus the active root and find the first text node holding `needle`.
    const findText = (needle: string) => {
      const el = root()
      el.focus()
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(needle)
        if (index >= 0) return { node, index }
      }
      return null
    }
    ;(window as any).__place = (needle: string, offset = 0) => {
      const found = findText(needle)
      if (found) getSelection()!.collapse(found.node, found.index + offset)
      return !!found
    }
    ;(window as any).__selectText = (needle: string, backward = false) => {
      const found = findText(needle)
      if (!found) return false
      const { node, index } = found
      const end = index + needle.length
      if (backward) getSelection()!.setBaseAndExtent(node, end, node, index)
      else getSelection()!.setBaseAndExtent(node, index, node, end)
      return true
    }
    // Select All's document stage: both endpoints on the editable root (Tasks 613/617).
    ;(window as any).__selectRoot = () => {
      const el = root()
      el.focus()
      getSelection()!.setBaseAndExtent(el, 0, el, el.childNodes.length)
      return getSelection()!.toString().length
    }
    ;(window as any).__selectedLength = () => getSelection()!.toString().length
    // Task 601: when the last key went down, to measure the key-to-history interval.
    let lastKeyAt = 0
    window.addEventListener(
      'keydown',
      () => {
        lastKeyAt = performance.now()
      },
      true,
    )
    // The state at history entry, read just before the routed Undo/Redo runs.
    ;(window as any).__history = (kind: 'undo' | 'redo') => {
      const entry = {
        sinceKey: performance.now() - lastKeyAt,
        stack: (window as any).__stack(),
        value: editor.getValue(),
        host: host.text,
        sinkPending: sink.pending,
      }
      ;(window as any)[kind === 'undo' ? '__undo' : '__redo']()
      return entry
    }
    ;(window as any).__readyValue = editor.getValue()
    focusEnd()
    ;(window as any).__readyStacks = (window as any).__stacks()
    ;(window as any).__ready = true
  },
})
