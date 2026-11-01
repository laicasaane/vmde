// Leading + trailing-per-frame coalescing for MutationObserver callbacks (185/2c).
//
// Several editor observers (code-source, callouts, html-comment, echarts-fit) must run
// BEFORE PAINT so the user never sees an undecorated frame — which is why they were
// written fully synchronous. But a single keystroke fans out into SEVERAL mutation
// checkpoints (Vditor's spin, then our own fix-up modules), and each checkpoint used to
// pay a full subtree walk.
//
// This keeps the no-flash guarantee while collapsing the burst: the FIRST batch of a
// frame runs `fn` synchronously (before paint, exactly as today); every further batch in
// the same frame folds into ONE trailing re-run scheduled via requestAnimationFrame —
// which the event loop also executes before that frame paints. Net: at most 2 walks per
// frame instead of N, and no mutation is ever painted undecorated.
// Task 643: a streamed Preview appends hundreds of blocks per frame while the decorating observers
// (code references, bare URLs, colour literals, callouts, comments) each rescan the whole pane on
// every batch, which is quadratic in the document size. While the stream holds a pause, those batches
// are only remembered; when it resumes each observer runs ONCE, one per animation frame so the
// catch-up passes do not land in a single task.
let pauseDepth = 0
const deferredRuns = new Set<() => void>()

/** Hold every coalesced observer back until the returned resume function is called. Nestable. */
export function pauseCoalescedObservers(): () => void {
  pauseDepth++
  let resumed = false
  return () => {
    if (resumed) return
    resumed = true
    pauseDepth--
    if (pauseDepth > 0) return
    const queue = [...deferredRuns]
    deferredRuns.clear()
    const next = () => {
      const run = queue.shift()
      if (!run) return
      run()
      if (queue.length) requestAnimationFrame(next)
    }
    next()
  }
}

/** True when observers are paused; `resume` is then queued (once) to run at the resume. */
export function deferWhilePaused(resume: () => void): boolean {
  if (pauseDepth === 0) return false
  deferredRuns.add(resume)
  return true
}

interface FrameCoalesced {
  (): void
  /** Drop a pending trailing re-run (call from the observer's disposer). */
  cancel(): void
}

export function coalescePerFrame(fn: () => void): FrameCoalesced {
  let rafId = 0
  let dirtyAgain = false
  const resume = () => handler()
  const handler = (() => {
    if (deferWhilePaused(resume)) return
    if (rafId) {
      dirtyAgain = true
      return
    }
    fn() // leading edge: synchronous, before paint
    rafId = requestAnimationFrame(() => {
      rafId = 0
      if (dirtyAgain) {
        dirtyAgain = false
        fn() // trailing edge: coalesced, still before this frame's paint
      }
    })
  }) as FrameCoalesced
  handler.cancel = () => {
    deferredRuns.delete(resume)
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    dirtyAgain = false
  }
  return handler
}

// Same leading-sync + trailing-rAF coalescing as coalescePerFrame, but ALSO accumulates the
// MutationRecords across a same-frame burst and hands the union to `fn` — task 173's block-scoping
// (mutation-scope.ts) needs the records themselves, not just a "something changed" ping, and a
// per-callback array would lose whatever mutated during the trailing coalesced window.
interface FrameCoalescedRecords {
  (records: MutationRecord[]): void
  /** Drop a pending trailing re-run (call from the observer's disposer). */
  cancel(): void
}

export function coalescePerFrameWithRecords(
  fn: (records: MutationRecord[]) => void,
): FrameCoalescedRecords {
  let rafId = 0
  let pending: MutationRecord[] = []
  // Empty records mean "scope unknown", which every user of the records treats as a full pass.
  const resume = () => handler([])
  const handler = ((records: MutationRecord[]) => {
    if (deferWhilePaused(resume)) return
    if (rafId) {
      pending.push(...records)
      return
    }
    fn(records) // leading edge: synchronous, before paint
    pending = []
    rafId = requestAnimationFrame(() => {
      rafId = 0
      if (pending.length) {
        const batch = pending
        pending = []
        fn(batch) // trailing edge: coalesced, still before this frame's paint
      }
    })
  }) as FrameCoalescedRecords
  handler.cancel = () => {
    deferredRuns.delete(resume)
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    pending = []
  }
  return handler
}

// A THIRD, plainer shape (task 502 — abc-fit.ts and smiles-render.ts each carried a byte-
// identical copy): watch `appEl`'s subtree, rAF-debounce, run `redraw` once settled, plus an
// initial sweep. Deliberately NOT coalescePerFrame's leading-edge-synchronous shape — these
// callbacks redraw an SVG in place, and running one synchronously from inside the
// MutationObserver callback (rather than after a microtask/rAF hop) risks re-entering the
// observer on its own writes. No flag between this and the two above: different re-entrancy
// contract, not a mode switch on the same behaviour.
export function observeSubtreeRafDebounced(
  appEl: HTMLElement | null | undefined,
  redraw: (appEl: HTMLElement) => void,
): () => void {
  // No editor root mounted yet — nothing to observe; hand back a no-op
  // disposer so callers can always call the returned teardown unconditionally.
  if (!appEl)
    return () => {
      /* no-op disposer */
    }
  let raf = 0
  const run = () => {
    raf = 0
    redraw(appEl)
  }
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(run)
  }
  const obs = new MutationObserver(schedule)
  obs.observe(appEl, { childList: true, subtree: true })
  schedule()
  return () => {
    obs.disconnect()
    if (raf) cancelAnimationFrame(raf)
  }
}
