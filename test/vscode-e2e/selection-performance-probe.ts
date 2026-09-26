export interface SelectionPerformanceProbeResult {
  elapsedWorkloadMs: number
  elapsedObservedMs: number
  fullGetValueCalls: number
  liveMarkerInsertions: number
  rangeInsertCalls: number
  selectionEvents: number
  luteEntryPoints: Record<string, number>
  rootLuteCalls: number
  fragmentLuteCalls: number
  blockHandleProofs: number
  blockHandleSnapshots: number
  /** Source-block-index builds (`nav/source-block-index.ts`), read from the opt-in
   * `__vmdeBlockHandleCacheMetrics` object every harness installs; see `indexBuildsInstrumented`. */
  indexBuilds: number
  indexBuildsInstrumented: boolean
  sampledFrames: number
  frameGapsMs: number[]
  longTaskDurationsMs: number[]
  shiftRightKeyTimesMs: number[]
  // --- Task 577 Checkpoint 1 settle recorder (below) ---
  /** True once one release (pointerup, or a Shift/ArrowRight keyup) and one subsequent bubble
   * hidden->visible transition were both observed in this armed window. When false, the
   * settle* fields below are all 0 (nothing to attribute — e.g. a cold-hover phase with no
   * release event, or a harness with no `.vmde-selection-bubble`). */
  settleObserved: boolean
  /** Whether `.vmde-selection-bubble` exists in this document at all (details/block-handle-only
   * harnesses do not install the bubble, so settle fields there are always unobserved). */
  settleBubblePresent: boolean
  /** Last release (pointerup, or last Shift/ArrowRight keyup) to the bubble's hidden->visible
   * DOM mutation. */
  releaseToShowMs: number
  /** Last release to the first rAF sampled after that mutation (the first frame that can have
   * painted the shown bubble). */
  releaseToVisibleFrameMs: number
  /** Longest PerformanceObserver longtask entry overlapping [release, visibleFrame]. */
  settleLongestTaskMs: number
  /** Largest gap between rAF samples (or the window edges) inside [release, visibleFrame]. */
  settleMaxRafGapMs: number
  settleIndexBuildsBeforeVisible: number
  settleFullGetValueBeforeVisible: number
  settleLiveMarkersBeforeVisible: number
  settleRootLuteCallsBeforeVisible: number
  settleFragmentLuteCallsBeforeVisible: number
  settleBubbleTogglesBeforeVisible: number
  /** Same counters for (visibleFrame, stop()) — the rest of the fixed 500 ms observation window. */
  settleIndexBuildsAfterVisible: number
  settleFullGetValueAfterVisible: number
  settleLiveMarkersAfterVisible: number
  settleRootLuteCallsAfterVisible: number
  settleFragmentLuteCallsAfterVisible: number
  settleBubbleTogglesAfterVisible: number
}

interface SettleSnapshot {
  fullGetValueCalls: number
  indexBuilds: number
  liveMarkerInsertions: number
  rootLuteCalls: number
  fragmentLuteCalls: number
  bubbleToggleCount: number
}

/** Installs transparent, test-local work counters after the editor is ready. */
export function installSelectionPerformanceProbe(
  bodyOrMarkdown: HTMLElement | SVGElement | string,
  markdownArgument?: string,
) {
  const largeMarkdown =
    typeof bodyOrMarkdown === 'string' ? bodyOrMarkdown : markdownArgument
  if (typeof largeMarkdown !== 'string')
    throw new Error('selection performance probe needs the editor source')
  const win = window as Window & {
    vditor?: any
    __selectionPerformanceProbe?: {
      start(): void
      /** Full `getValue` calls so far in the armed window, for quiescence polling. */
      fullGetValueCalls(): number
      endWorkload(): void
      stop(): SelectionPerformanceProbeResult
    }
    __vmdeBlockHandleCacheMetrics?: Record<string, number>
    __blockHandleMetrics?: Record<string, number>
  }
  const outer = win.vditor
  const inner = outer?.vditor
  const lute = inner?.lute
  if (!outer || !inner || !lute) throw new Error('editor is not ready')

  const metrics = {
    armed: false,
    startedAt: 0,
    workloadEndedAt: 0,
    fullGetValueCalls: 0,
    liveMarkerInsertions: 0,
    rangeInsertCalls: 0,
    selectionEvents: 0,
    luteEntryPoints: {} as Record<string, number>,
    rootLuteCalls: 0,
    fragmentLuteCalls: 0,
    sampledFrames: 0,
    lastFrameAt: 0,
    frameGapsMs: [] as number[],
    longTaskDurationsMs: [] as number[],
    shiftRightKeyTimesMs: [] as number[],
    // Settle-only bookkeeping, not part of the pre-existing public counters above.
    frameTimestamps: [] as number[],
    longTaskEntries: [] as { start: number; duration: number }[],
  }

  // Settle recorder state (Task 577 Checkpoint 1). Kept separate from `metrics` above so the
  // pre-existing fields and their reset/armed semantics are untouched.
  const settle = {
    releaseAt: 0,
    showAt: 0,
    visibleFrameAt: 0,
    pendingVisibleRaf: 0,
    bubbleToggleCount: 0,
    releaseSnapshot: null as SettleSnapshot | null,
    visibleSnapshot: null as SettleSnapshot | null,
  }

  const editorRoot = (): HTMLElement | null => {
    const mode = inner.currentMode
    if (mode === 'ir') return inner.ir?.element ?? null
    if (mode === 'wysiwyg') return inner.wysiwyg?.element ?? null
    return null
  }
  let rootHtmlAtStart = ''
  const isWholeDocumentInput = (value: unknown): boolean => {
    if (typeof value !== 'string') return false
    if (value === largeMarkdown || value === rootHtmlAtStart) return true
    const withoutMarkers = value.replace(
      /VMDE_REWRAP_START_*|VMDE_REWRAP_END_*/g,
      '',
    )
    return withoutMarkers === rootHtmlAtStart
  }
  const blockMetrics =
    win.__vmdeBlockHandleCacheMetrics ?? win.__blockHandleMetrics
  const snapshotCount = () =>
    blockMetrics?.blockHandleSnapshotCalls ?? blockMetrics?.snapshotCalls ?? 0
  const resetSnapshotCount = () => {
    if (!blockMetrics) return
    if ('blockHandleSnapshotCalls' in blockMetrics)
      blockMetrics.blockHandleSnapshotCalls = 0
    if ('snapshotCalls' in blockMetrics) blockMetrics.snapshotCalls = 0
    if ('indexBuilds' in blockMetrics) blockMetrics.indexBuilds = 0
  }
  const indexBuilds = () => blockMetrics?.indexBuilds ?? 0
  const originalGetValue = outer.getValue.bind(outer)
  outer.getValue = (...args: unknown[]) => {
    if (metrics.armed) metrics.fullGetValueCalls++
    return originalGetValue(...args)
  }

  // Exact document identity separates root serialization from detached fragment proofs. A size
  // threshold can misclassify one large code/list fragment as the document.
  for (const name of [
    'VditorIRDOM2Md',
    'VditorDOM2Md',
    'Md2VditorIRDOM',
    'Md2VditorDOM',
  ]) {
    const original = lute[name]
    if (typeof original !== 'function') continue
    lute[name] = function (...args: unknown[]) {
      if (metrics.armed) {
        metrics.luteEntryPoints[name] = (metrics.luteEntryPoints[name] ?? 0) + 1
        if (isWholeDocumentInput(args[0])) metrics.rootLuteCalls++
        else metrics.fragmentLuteCalls++
      }
      return original.apply(this, args)
    }
  }

  const originalInsertNode = Range.prototype.insertNode
  Range.prototype.insertNode = function (node: Node) {
    if (metrics.armed) {
      const root = editorRoot()
      if (root?.contains(this.startContainer)) {
        metrics.rangeInsertCalls++
        const text =
          node.nodeType === Node.TEXT_NODE ? (node.textContent ?? '') : ''
        if (
          text.startsWith('VMDE_REWRAP_START') ||
          text.startsWith('VMDE_REWRAP_END')
        )
          metrics.liveMarkerInsertions++
      }
    }
    return originalInsertNode.call(this, node)
  }

  document.addEventListener(
    'selectionchange',
    () => {
      if (metrics.armed) metrics.selectionEvents++
    },
    true,
  )
  document.addEventListener(
    'keydown',
    (event) => {
      if (metrics.armed && event.key === 'ArrowRight' && event.shiftKey)
        metrics.shiftRightKeyTimesMs.push(performance.now())
    },
    true,
  )

  let longTaskObserver: PerformanceObserver | undefined
  if (
    typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes?.includes('longtask')
  ) {
    longTaskObserver = new PerformanceObserver((entries) => {
      if (!metrics.armed) return
      for (const entry of entries.getEntries()) {
        metrics.longTaskDurationsMs.push(entry.duration)
        metrics.longTaskEntries.push({
          start: entry.startTime,
          duration: entry.duration,
        })
      }
    })
  }

  const sampleFrame = (now: number) => {
    if (!metrics.armed) return
    if (metrics.lastFrameAt) metrics.frameGapsMs.push(now - metrics.lastFrameAt)
    metrics.lastFrameAt = now
    metrics.sampledFrames++
    metrics.frameTimestamps.push(now)
    requestAnimationFrame(sampleFrame)
  }

  // --- Settle recorder (Task 577 Checkpoint 1) ---
  const currentSettleSnapshot = (): SettleSnapshot => ({
    fullGetValueCalls: metrics.fullGetValueCalls,
    indexBuilds: indexBuilds(),
    liveMarkerInsertions: metrics.liveMarkerInsertions,
    rootLuteCalls: metrics.rootLuteCalls,
    fragmentLuteCalls: metrics.fragmentLuteCalls,
    bubbleToggleCount: settle.bubbleToggleCount,
  })
  const bubbleElement = (): HTMLElement | null =>
    document.querySelector('.vmde-selection-bubble')
  const markShown = (at: number) => {
    if (settle.showAt) return
    settle.showAt = at
    settle.visibleSnapshot = currentSettleSnapshot()
    settle.pendingVisibleRaf = requestAnimationFrame(() => {
      settle.visibleFrameAt = performance.now()
    })
  }
  // The release listener is registered once, at install time, and is a no-op unless armed — the
  // handoff calls for "a window capture listener registered at install time".
  const onRelease = () => {
    if (!metrics.armed) return
    const now = performance.now()
    settle.releaseAt = now
    settle.releaseSnapshot = currentSettleSnapshot()
    // A later release supersedes any show detection still pending from an earlier one (e.g. a
    // burst-keyboard phase fires one keyup per Shift/ArrowRight edge).
    settle.showAt = 0
    settle.visibleFrameAt = 0
    settle.visibleSnapshot = null
    if (settle.pendingVisibleRaf) cancelAnimationFrame(settle.pendingVisibleRaf)
    settle.pendingVisibleRaf = 0
    // If the bubble is already visible at release (e.g. a slow-keyboard phase where an earlier
    // keystroke's debounce already painted it), there is no further hidden->visible mutation to
    // observe — the toolbar was already showing when the gesture ended.
    const el = bubbleElement()
    if (el && !el.hidden) markShown(now)
  }
  window.addEventListener('pointerup', onRelease, true)
  window.addEventListener(
    'keyup',
    (event) => {
      if (event.key === 'Shift' || event.key === 'ArrowRight') onRelease()
    },
    true,
  )
  let bubbleObserver: MutationObserver | undefined
  const observeBubble = (): boolean => {
    if (bubbleObserver) return true
    const el = bubbleElement()
    if (!el) return false
    bubbleObserver = new MutationObserver((records) => {
      if (!metrics.armed) return
      for (const record of records) {
        if (record.attributeName !== 'hidden') continue
        settle.bubbleToggleCount++
        if (!el.hidden && settle.releaseAt) markShown(performance.now())
      }
    })
    bubbleObserver.observe(el, {
      attributes: true,
      attributeFilter: ['hidden'],
    })
    return true
  }

  win.__selectionPerformanceProbe = {
    start() {
      metrics.fullGetValueCalls = 0
      metrics.liveMarkerInsertions = 0
      metrics.rangeInsertCalls = 0
      metrics.selectionEvents = 0
      metrics.luteEntryPoints = {}
      metrics.rootLuteCalls = 0
      metrics.fragmentLuteCalls = 0
      metrics.sampledFrames = 0
      metrics.lastFrameAt = 0
      metrics.frameGapsMs = []
      metrics.longTaskDurationsMs = []
      metrics.shiftRightKeyTimesMs = []
      metrics.frameTimestamps = []
      metrics.longTaskEntries = []
      resetSnapshotCount()
      rootHtmlAtStart = editorRoot()?.innerHTML ?? ''
      metrics.startedAt = performance.now()
      metrics.workloadEndedAt = 0
      longTaskObserver?.observe({ type: 'longtask', buffered: false })
      // Arming (re)tries to attach the bubble observer: the bubble element may not exist yet on
      // the very first start() call in a harness that creates it lazily.
      observeBubble()
      settle.releaseAt = 0
      settle.showAt = 0
      settle.visibleFrameAt = 0
      settle.bubbleToggleCount = 0
      settle.releaseSnapshot = null
      settle.visibleSnapshot = null
      if (settle.pendingVisibleRaf)
        cancelAnimationFrame(settle.pendingVisibleRaf)
      settle.pendingVisibleRaf = 0
      metrics.armed = true
      requestAnimationFrame(sampleFrame)
    },
    fullGetValueCalls() {
      return metrics.fullGetValueCalls
    },
    endWorkload() {
      metrics.workloadEndedAt = performance.now()
    },
    stop() {
      const stoppedAt = performance.now()
      metrics.armed = false
      longTaskObserver?.disconnect()
      const settleObserved = Boolean(settle.releaseAt && settle.visibleFrameAt)
      const finalSnapshot = currentSettleSnapshot()
      const before = (key: keyof SettleSnapshot): number =>
        settleObserved && settle.releaseSnapshot && settle.visibleSnapshot
          ? settle.visibleSnapshot[key] - settle.releaseSnapshot[key]
          : 0
      const after = (key: keyof SettleSnapshot): number =>
        settleObserved && settle.visibleSnapshot
          ? finalSnapshot[key] - settle.visibleSnapshot[key]
          : 0
      const settleLongestTaskMs = settleObserved
        ? metrics.longTaskEntries.reduce((max, task) => {
            const end = task.start + task.duration
            return end > settle.releaseAt && task.start < settle.visibleFrameAt
              ? Math.max(max, task.duration)
              : max
          }, 0)
        : 0
      const settleMaxRafGapMs = settleObserved
        ? (() => {
            const points = [
              settle.releaseAt,
              ...metrics.frameTimestamps.filter(
                (t) => t > settle.releaseAt && t < settle.visibleFrameAt,
              ),
              settle.visibleFrameAt,
            ].sort((a, b) => a - b)
            let max = 0
            for (let index = 1; index < points.length; index++)
              max = Math.max(max, points[index] - points[index - 1])
            return max
          })()
        : 0
      return {
        elapsedWorkloadMs: Math.round(
          (metrics.workloadEndedAt || stoppedAt) - metrics.startedAt,
        ),
        elapsedObservedMs: Math.round(stoppedAt - metrics.startedAt),
        fullGetValueCalls: metrics.fullGetValueCalls,
        liveMarkerInsertions: metrics.liveMarkerInsertions,
        rangeInsertCalls: metrics.rangeInsertCalls,
        selectionEvents: metrics.selectionEvents,
        luteEntryPoints: { ...metrics.luteEntryPoints },
        rootLuteCalls: metrics.rootLuteCalls,
        fragmentLuteCalls: metrics.fragmentLuteCalls,
        blockHandleProofs: metrics.fragmentLuteCalls,
        blockHandleSnapshots: snapshotCount(),
        indexBuilds: indexBuilds(),
        indexBuildsInstrumented: Boolean(
          blockMetrics && 'indexBuilds' in blockMetrics,
        ),
        sampledFrames: metrics.sampledFrames,
        frameGapsMs: [...metrics.frameGapsMs],
        longTaskDurationsMs: [...metrics.longTaskDurationsMs],
        shiftRightKeyTimesMs: [...metrics.shiftRightKeyTimesMs],
        settleObserved,
        settleBubblePresent:
          Boolean(bubbleElement()) || Boolean(bubbleObserver),
        releaseToShowMs: settleObserved
          ? Math.round(settle.showAt - settle.releaseAt)
          : 0,
        releaseToVisibleFrameMs: settleObserved
          ? Math.round(settle.visibleFrameAt - settle.releaseAt)
          : 0,
        settleLongestTaskMs: Math.round(settleLongestTaskMs),
        settleMaxRafGapMs: Math.round(settleMaxRafGapMs),
        settleIndexBuildsBeforeVisible: before('indexBuilds'),
        settleFullGetValueBeforeVisible: before('fullGetValueCalls'),
        settleLiveMarkersBeforeVisible: before('liveMarkerInsertions'),
        settleRootLuteCallsBeforeVisible: before('rootLuteCalls'),
        settleFragmentLuteCallsBeforeVisible: before('fragmentLuteCalls'),
        settleBubbleTogglesBeforeVisible: before('bubbleToggleCount'),
        settleIndexBuildsAfterVisible: after('indexBuilds'),
        settleFullGetValueAfterVisible: after('fullGetValueCalls'),
        settleLiveMarkersAfterVisible: after('liveMarkerInsertions'),
        settleRootLuteCallsAfterVisible: after('rootLuteCalls'),
        settleFragmentLuteCallsAfterVisible: after('fragmentLuteCalls'),
        settleBubbleTogglesAfterVisible: after('bubbleToggleCount'),
      }
    },
  }
}
