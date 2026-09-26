/**
 * Task 196 Checkpoint 1 — test-only work counters for the Find & Replace widget
 * (`media-src/src/editing/selection-scope.ts`, `installFindReplace`). Pattern mirrors
 * `selection-performance-probe.ts`: transparent wraps installed once per page/frame, armed per
 * phase with `start()`/`endWorkload()`/`stop()`. Shared between the Chromium harness
 * (`media-src/e2e/find-replace.spec.ts`) and real VS Code (`test/vscode-e2e/find-replace.spec.ts`).
 *
 * Counts, not just elapsed time, are the red-assertion currency (task record, Checkpoint 1 step 7):
 * whole-document Lute calls, editor deep clones, `setValue` calls, `MutationObserver`
 * constructions, and (real VS Code only) source-block-index builds.
 */
export interface FindReplaceProbeResult {
  /** Phase wall time, `endWorkload()` minus `start()`. */
  elapsedWorkloadMs: number
  /** Full `window.vditor.getValue()` calls. */
  fullGetValueCalls: number
  /** Per-Lute-entry-point call counts (`VditorIRDOM2Md`, `VditorDOM2Md`, `Md2VditorIRDOM`,
   * `Md2VditorDOM`), split below into whole-document vs fragment by comparing the call's markdown
   * argument against the last known whole-document HTML/markdown. */
  luteEntryPoints: Record<string, number>
  rootLuteCalls: number
  fragmentLuteCalls: number
  /** `Node.prototype.cloneNode(true)` calls where `this` is the active mode's editor root — the
   * whole-editor deep clone `serializeFindClone` performs per batch. */
  editorDeepClones: number
  /** `window.vditor.setValue` calls (the whole-document re-render Replace/Replace All perform). */
  setValueCalls: number
  /** `new MutationObserver(...)` constructions anywhere on the page while armed — `cachePoints`
   * recreates Find's private mapping observer on every call. */
  mutationObserversCreated: number
  /** Source-block-index builds, real VS Code only (`__vmdeBlockHandleCacheMetrics.indexBuilds`,
   * same field `selection-performance-probe.ts` reads). Always 0/uninstrumented in Chromium. */
  indexBuilds: number
  indexBuildsInstrumented: boolean
  longTaskCount: number
  longTaskTotalMs: number
  longTaskMaxMs: number
  /** Largest gap between sampled animation frames while armed — a proxy for a blocked main thread
   * that a longtask entry alone can miss (Chromium's longtask threshold is 50ms; a script that
   * yields every 40ms still stalls painting without ever registering one). */
  maxRafGapMs: number
  sampledFrames: number
  /** `.vmde-find-overlay` element count in the document at `stop()` time. */
  overlayCount: number
}

interface ArmedState {
  armed: boolean
  startedAt: number
  workloadEndedAt: number
  fullGetValueCalls: number
  luteEntryPoints: Record<string, number>
  rootLuteCalls: number
  fragmentLuteCalls: number
  editorDeepClones: number
  setValueCalls: number
  mutationObserversCreated: number
  lastFrameAt: number
  sampledFrames: number
  maxRafGapMs: number
  longTaskDurations: number[]
}

type ProbeWindow = Window & {
  vditor?: {
    getValue?(): string
    setValue?(markdown: string): void
    vditor?: {
      currentMode?: string
      lute?: Record<string, unknown>
      ir?: { element?: HTMLElement }
      wysiwyg?: { element?: HTMLElement }
      sv?: { element?: HTMLElement }
    }
  }
  __vmdeBlockHandleCacheMetrics?: Record<string, number>
  __vmdeFindReplaceProbe?: {
    start(): void
    endWorkload(): void
    stop(): FindReplaceProbeResult
  }
}

/** Installs the probe once per page load. Idempotent: a second call is a no-op so a spec can call
 * it defensively before every phase without double-wrapping `cloneNode`/Lute/`MutationObserver`. */
export function installFindReplaceProbe(): void {
  const win = window as ProbeWindow
  if (win.__vmdeFindReplaceProbe) return
  const outer = win.vditor
  const inner = outer?.vditor
  const lute = inner?.lute
  if (!outer || !inner || !lute) throw new Error('editor is not ready')

  const state: ArmedState = {
    armed: false,
    startedAt: 0,
    workloadEndedAt: 0,
    fullGetValueCalls: 0,
    luteEntryPoints: {},
    rootLuteCalls: 0,
    fragmentLuteCalls: 0,
    editorDeepClones: 0,
    setValueCalls: 0,
    mutationObserversCreated: 0,
    lastFrameAt: 0,
    sampledFrames: 0,
    maxRafGapMs: 0,
    longTaskDurations: [],
  }

  const editorRoot = (): HTMLElement | null => {
    const mode = inner.currentMode
    if (mode === 'ir') return inner.ir?.element ?? null
    if (mode === 'wysiwyg') return inner.wysiwyg?.element ?? null
    if (mode === 'sv') return inner.sv?.element ?? null
    return null
  }

  // `getValue()` is the shared entry point every refresh, replace and replace-all path calls
  // first; wrapping it here (rather than only the Lute entry points) also catches SV, which has no
  // Lute probe at all (root cause reading, Part 1 handoff).
  const originalGetValue = outer.getValue?.bind(outer)
  if (originalGetValue) {
    outer.getValue = (...args: unknown[]) => {
      if (state.armed) state.fullGetValueCalls++
      return originalGetValue(...args)
    }
  }

  const originalSetValue = outer.setValue?.bind(outer)
  if (originalSetValue) {
    outer.setValue = (...args: unknown[]) => {
      if (state.armed) state.setValueCalls++
      return (originalSetValue as (...a: unknown[]) => void)(...args)
    }
  }

  // Whole-document vs fragment: a call's markdown/HTML argument is classified against the active
  // root's current innerHTML (candidate clones pass `clone.innerHTML`, so this must be re-read
  // per-call, not cached once — the editor root's content changes across phases).
  const isWholeDocumentInput = (value: unknown): boolean => {
    if (typeof value !== 'string') return false
    const root = editorRoot()
    return Boolean(root && value === root.innerHTML)
  }
  for (const name of [
    'VditorIRDOM2Md',
    'VditorDOM2Md',
    'Md2VditorIRDOM',
    'Md2VditorDOM',
  ]) {
    const original = (lute as Record<string, unknown>)[name]
    if (typeof original !== 'function') continue
    ;(lute as Record<string, unknown>)[name] = function (...args: unknown[]) {
      if (state.armed) {
        state.luteEntryPoints[name] = (state.luteEntryPoints[name] ?? 0) + 1
        if (isWholeDocumentInput(args[0])) state.rootLuteCalls++
        else state.fragmentLuteCalls++
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args)
    }
  }

  // `serializeFindClone` (selection-scope.ts) calls `editor.cloneNode(true)` once per 24-node
  // batch. Wrapping the global prototype and filtering by `this === root && deep` is the only way
  // to observe this without a product-source change (test-only instrumentation constraint).
  const originalCloneNode = Node.prototype.cloneNode
  Node.prototype.cloneNode = function (this: Node, deep?: boolean): Node {
    if (state.armed && deep && this === editorRoot()) state.editorDeepClones++
    return originalCloneNode.call(this, deep)
  }

  const OriginalMutationObserver = window.MutationObserver
  class CountingMutationObserver extends OriginalMutationObserver {
    constructor(callback: MutationCallback) {
      super(callback)
      if (state.armed) state.mutationObserversCreated++
    }
  }
  // Replaces the global constructor for one test-only counter; nothing restores it because each
  // spec/page load is single-use.
  window.MutationObserver =
    CountingMutationObserver as unknown as typeof MutationObserver

  const blockMetrics = () => win.__vmdeBlockHandleCacheMetrics
  const indexBuilds = () => blockMetrics()?.indexBuilds ?? 0

  let longTaskObserver: PerformanceObserver | undefined
  if (
    typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes?.includes('longtask')
  ) {
    longTaskObserver = new PerformanceObserver((entries) => {
      if (!state.armed) return
      for (const entry of entries.getEntries())
        state.longTaskDurations.push(entry.duration)
    })
  }

  const sampleFrame = (now: number) => {
    if (!state.armed) return
    if (state.lastFrameAt)
      state.maxRafGapMs = Math.max(state.maxRafGapMs, now - state.lastFrameAt)
    state.lastFrameAt = now
    state.sampledFrames++
    requestAnimationFrame(sampleFrame)
  }

  win.__vmdeFindReplaceProbe = {
    start() {
      state.fullGetValueCalls = 0
      state.luteEntryPoints = {}
      state.rootLuteCalls = 0
      state.fragmentLuteCalls = 0
      state.editorDeepClones = 0
      state.setValueCalls = 0
      state.mutationObserversCreated = 0
      state.lastFrameAt = 0
      state.sampledFrames = 0
      state.maxRafGapMs = 0
      state.longTaskDurations = []
      if (blockMetrics() && 'indexBuilds' in blockMetrics()!)
        blockMetrics()!.indexBuilds = 0
      state.startedAt = performance.now()
      state.workloadEndedAt = 0
      longTaskObserver?.observe({ type: 'longtask', buffered: false })
      state.armed = true
      requestAnimationFrame(sampleFrame)
    },
    endWorkload() {
      state.workloadEndedAt = performance.now()
    },
    stop(): FindReplaceProbeResult {
      const stoppedAt = performance.now()
      state.armed = false
      longTaskObserver?.disconnect()
      return {
        elapsedWorkloadMs: Math.round(
          (state.workloadEndedAt || stoppedAt) - state.startedAt,
        ),
        fullGetValueCalls: state.fullGetValueCalls,
        luteEntryPoints: { ...state.luteEntryPoints },
        rootLuteCalls: state.rootLuteCalls,
        fragmentLuteCalls: state.fragmentLuteCalls,
        editorDeepClones: state.editorDeepClones,
        setValueCalls: state.setValueCalls,
        mutationObserversCreated: state.mutationObserversCreated,
        indexBuilds: indexBuilds(),
        indexBuildsInstrumented: Boolean(
          blockMetrics() && 'indexBuilds' in blockMetrics()!,
        ),
        longTaskCount: state.longTaskDurations.length,
        longTaskTotalMs: Math.round(
          state.longTaskDurations.reduce((sum, d) => sum + d, 0),
        ),
        longTaskMaxMs: Math.round(
          state.longTaskDurations.reduce((max, d) => Math.max(max, d), 0),
        ),
        maxRafGapMs: Math.round(state.maxRafGapMs),
        sampledFrames: state.sampledFrames,
        overlayCount: document.querySelectorAll('.vmde-find-overlay').length,
      }
    },
  }
}
