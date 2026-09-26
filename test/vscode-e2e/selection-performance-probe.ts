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
      /\uE100VMDE_REWRAP_START_*|\uE101VMDE_REWRAP_END_*/g,
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
          text.startsWith('\uE100VMDE_REWRAP_START') ||
          text.startsWith('\uE101VMDE_REWRAP_END')
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
      for (const entry of entries.getEntries())
        metrics.longTaskDurationsMs.push(entry.duration)
    })
  }

  const sampleFrame = (now: number) => {
    if (!metrics.armed) return
    if (metrics.lastFrameAt) metrics.frameGapsMs.push(now - metrics.lastFrameAt)
    metrics.lastFrameAt = now
    metrics.sampledFrames++
    requestAnimationFrame(sampleFrame)
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
      resetSnapshotCount()
      rootHtmlAtStart = editorRoot()?.innerHTML ?? ''
      metrics.startedAt = performance.now()
      metrics.workloadEndedAt = 0
      longTaskObserver?.observe({ type: 'longtask', buffered: false })
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
      }
    },
  }
}
