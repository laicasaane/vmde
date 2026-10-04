// Debounced host-sync trigger for editor edits (tasks 58 + 68).
//
// The webview owns when the document is serialised to markdown and posted to the
// host (Vditor no longer does it per input — see the fixIrInputSerialize patch).
// This just debounces:
//  - `schedule()` → run `onIdle` after `wait` ms of quiet. `onIdle` may be async
//    (it shows a busy cursor + yields a paint before the slow serialize on large
//    docs).
//  - `flush()` → run `onFlush` immediately and cancel any pending timer. `onFlush`
//    is synchronous and must post the live content BEFORE VS Code saves (task 58:
//    a save inside the debounce window must not persist stale content).
//
// Free of any Vditor/VS Code reference so it can be unit-tested directly.
interface PendingEditOptions {
  wait: number
  onIdle: () => void | Promise<void>
  onFlush: () => void
}

interface PendingEdit {
  schedule(): void
  flush(): void
  cancel(): void
  readonly pending: boolean
}

export function createPendingEdit(opts: PendingEditOptions): PendingEdit {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  return {
    schedule() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        // `onIdle` may return a Promise; this module stays free of any Vditor/VS Code
        // reference (see the header) so it can't report a rejection itself here — every
        // real `onIdle` implementation is responsible for catching its own errors
        // internally (see edit-sync.ts's onIdle, task 482).
        void opts.onIdle()
      }, opts.wait)
    },
    flush() {
      cancel()
      opts.onFlush()
    },
    cancel,
    get pending() {
      return timer !== undefined
    },
  }
}
