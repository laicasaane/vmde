// Debounced host-sync trigger for editor edits (tasks 58 + 68).
//
// The webview owns when the document is serialised to markdown and posted to the
// host (Vditor no longer does it per input — see the fixIrInputSerialize patch).
// This just debounces:
//  - `schedule()` → run `onIdle` after `wait` ms of quiet. `onIdle` may be async
//    (it shows a busy cursor + yields a paint before the slow serialize on large
//    docs).
//  - Overdue rule (task 624): when timers are throttled or the main thread is busy, the trailing
//    timer can run late, and every key re-arms it before it fires. A `schedule()` that finds its
//    own pending timer at least `wait` old runs `onIdle('overdue')` at once, then arms a fresh
//    timer. With timers firing on time the timer is never that old when `schedule()` runs, so
//    ordinary typing keeps its post count.
//  - `flush()` → run `onFlush` immediately and cancel any pending timer. `onFlush`
//    is synchronous and must post the live content BEFORE VS Code saves (task 58:
//    a save inside the debounce window must not persist stale content).
//
// Free of any Vditor/VS Code reference so it can be unit-tested directly.
/** Why `onIdle` runs: the debounce timer fired, or a later `schedule()` found it overdue. */
export type PendingIdleReason = 'timer' | 'overdue'

interface PendingEditOptions {
  wait: number
  onIdle: (reason: PendingIdleReason) => void | Promise<void>
  onFlush: () => void
  /** Clock for the overdue check (test seam); defaults to `performance.now`. */
  now?: () => number
}

interface PendingEdit {
  schedule(): void
  flush(): void
  cancel(): void
  readonly pending: boolean
}

export function createPendingEdit(opts: PendingEditOptions): PendingEdit {
  let timer: ReturnType<typeof setTimeout> | undefined
  let armedAt = 0
  const now = opts.now ?? (() => performance.now())
  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  return {
    schedule() {
      const at = now()
      const overdue = timer !== undefined && at - armedAt >= opts.wait
      if (timer) clearTimeout(timer)
      armedAt = at
      timer = setTimeout(() => {
        timer = undefined
        // `onIdle` may return a Promise; this module stays free of any Vditor/VS Code
        // reference (see the header) so it can't report a rejection itself here — every
        // real `onIdle` implementation is responsible for catching its own errors
        // internally (see edit-sync.ts's onIdle, task 482).
        void opts.onIdle('timer')
      }, opts.wait)
      // After re-arming, so a re-entrant schedule() or a cancel() from `onIdle` sees a consistent state.
      if (overdue) void opts.onIdle('overdue')
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
