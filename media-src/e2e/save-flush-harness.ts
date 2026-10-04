import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { createPendingEdit } from '../src/bridge/pending-edit'
import { answerFlushForSave } from '../src/bridge/save-flush'
import { setBusyCursor, nextPaint } from '../src/chrome/busy-cursor'

// preload.ts's initVsCodeApi() call (task 470) picks up the spec's acquireVsCodeApi stub.
// Real Vditor (IR) wired exactly as main.ts for the edit-sync (tasks 58 + 68):
// the webview owns the markdown serialize (Vditor's per-input serialize is patched
// out). onIdle (debounced) serialises + posts, wrapping the slow serialize in a
// busy cursor on large docs; onFlush (the host's will-save `flush-for-save`, Task 580 CP2-12)
// posts synchronously before the reply.
// `?large=1` forces the large-doc path so the busy-cursor behaviour is testable.
const forceLarge = new URLSearchParams(location.search).get('large') === '1'
let editor: Vditor

// Record busy toggles so the spec can assert the serialize was wrapped.
;(window as any).__busyLog = []
const setBusy = (on: boolean) => {
  ;(window as any).__busyLog.push(on)
  setBusyCursor(on)
}
const postEdit = () =>
  (window as any).vscode.postMessage({
    command: 'edit',
    content: editor.getValue(),
  })

const pendingEdit = createPendingEdit({
  wait: 250,
  onIdle: async () => {
    if (forceLarge) {
      setBusy(true)
      await nextPaint()
      try {
        postEdit()
      } finally {
        setBusy(false)
      }
    } else {
      postEdit()
    }
  },
  onFlush: () => postEdit(),
})

editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value: 'start\n',
  // Vditor 3.11 calls this unconditionally while rendering the wysiwyg
  // toolbar; without it init throws (see main.ts).
  customWysiwygToolbar: () => {
    /* required stub — see comment above */
  },
  input() {
    pendingEdit.schedule()
  },
  after() {
    ;(window as any).vditor = editor
    ;(window as any).vditorTest = editor
    ;(window as any).__ready = true
  },
})

// Stand-in for message-router.ts's `flush-for-save` handler: the spec posts the host request
// with window.postMessage, as VS Code delivers it to the webview.
window.addEventListener('message', (event) => {
  if (event.data?.command !== 'flush-for-save') return
  answerFlushForSave(
    event.data.requestId,
    () => pendingEdit.flush(),
    (reply) => (window as any).vscode.postMessage(reply),
  )
})
