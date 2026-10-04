// Will-save flush (task 58, moved to the host's will-save by Task 580 CP2-12).
//
// Webview edits are debounced before being posted to the host (see pending-edit.ts), so a save
// inside the debounce window would write stale content. The host's onWillSaveTextDocument listener
// (src/session/editor-session.ts) covers every save route — the Save key under any binding, the
// Command Palette, menus and auto-save — by posting `flush-for-save`. This answers it: run the
// guarded flush, then reply. The reply is posted after any `edit` the flush produced, so the host
// already has that edit queued when the reply arrives. The old window keydown watch for a literal
// Ctrl/Cmd+S missed every other route and a remapped Save key.
import type { WebviewMessage } from '../../../src/shared/protocol'
import { reportError } from '../util/webview-log'

type FlushForSaveDone = Extract<
  WebviewMessage,
  { command: 'flush-for-save-done' }
>

// `flush` is `EditSync.flush()`: its Task 196 exact-ownership check keeps exact bytes the host
// already holds (after Find/Replace All, a block action or a rewrap) instead of posting Vditor's
// normalized serialization. It is undefined before the editor exists; the reply is still sent so
// the host's save never waits for its timeout, and a flush that throws is reported, not fatal.
export function answerFlushForSave(
  requestId: string,
  flush: (() => void) | undefined,
  post: (message: FlushForSaveDone) => void,
): void {
  try {
    flush?.()
  } catch (error) {
    reportError(error, 'flush-for-save')
  } finally {
    post({ command: 'flush-for-save-done', requestId })
  }
}
