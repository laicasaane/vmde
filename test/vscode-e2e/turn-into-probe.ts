/** Test-only, serializable Turn Into counters shared by Chromium and real VS Code. */
export type TurnIntoLuteKind =
  | 'liveRoot'
  | 'exact'
  | 'rendered'
  | 'largeOther'
  | 'fragment'

interface CounterChange {
  at: number
  delta: number
}

export interface TurnIntoRequestWork {
  observed: boolean
  startedAt: number
  endedAt: number
  elapsedMs: number
  fullGetValueCalls: number
  rootLuteCalls: number
  fragmentLuteCalls: number
  markerInsertions: number
  editSyncSnapshotCalls: number
  indexBuilds: number
}

export interface TurnIntoProbeResult {
  fullGetValueCalls: number
  setValueCalls: number
  optionsPostedCount: number
  postMessageInstrumented: boolean
  markerInsertions: number
  relevantRootMutations: number
  editSyncSnapshotCalls: number
  snapshotsInstrumented: boolean
  blockTransformCaptureCalls: number
  blockTransformOptionsReturned: number
  blockTransformIndexProofs: number
  blockTransformLegacyProofs: number
  indexBuilds: number
  postWorkloadIndexBuilds: number
  blockHandleSnapshotCalls: number
  cacheMetricsInstrumented: boolean
  elapsedMs: number
  longTaskMaxMs: number
  longTasksInstrumented: boolean
  rootLuteCalls: number
  fragmentLuteCalls: number
  maxFragmentInputLength: number
  fragmentInputChars: number
  luteKinds: Record<TurnIntoLuteKind, number>
  luteCalls: Array<{
    at: number
    entry: string
    inputLength: number
    kind: TurnIntoLuteKind
  }>
  getValueTimes: number[]
  markerInsertionTimes: number[]
  snapshotChanges: CounterChange[]
  indexBuildChanges: CounterChange[]
  snapshotChangesInstrumented: boolean
  indexBuildChangesInstrumented: boolean
  request: TurnIntoRequestWork
}

interface TurnIntoProbeWindow {
  vditor?: {
    getValue(): string
    setValue(...args: unknown[]): unknown
    vditor: {
      currentMode: string
      lute: Record<string, (...args: unknown[]) => unknown>
      ir?: { element: HTMLElement }
      wysiwyg?: { element: HTMLElement }
      sv?: { element: HTMLElement }
    }
  }
  vscode?: { postMessage(message: unknown): unknown }
  __exact?: () => string
  __vmdeE2EExactMarkdown?: () => string
  __vmdeIncrementalSeedStats?: { snapshotCalls: number }
  __vmdeBlockHandleCacheMetrics?: Record<string, number>
  __vmdeTurnIntoProbe?: {
    start(exact?: string): void
    endWorkload(): void
    stop(): TurnIntoProbeResult
  }
}

// Keep every runtime dependency inside this function: Playwright serializes the function itself.
export function installTurnIntoProbe(): void {
  const win = window as unknown as TurnIntoProbeWindow
  if (win.__vmdeTurnIntoProbe) return
  const outer = win.vditor
  if (!outer?.vditor.lute)
    throw new Error('Turn Into probe needs a live editor')
  const inner = outer.vditor
  const activeRoot = (): HTMLElement | null => {
    switch (inner.currentMode) {
      case 'ir':
        return inner.ir?.element ?? null
      case 'wysiwyg':
        return inner.wysiwyg?.element ?? null
      case 'sv':
        return inner.sv?.element ?? null
      default:
        return null
    }
  }
  const fresh = (): TurnIntoProbeResult => ({
    fullGetValueCalls: 0,
    setValueCalls: 0,
    optionsPostedCount: 0,
    postMessageInstrumented: false,
    markerInsertions: 0,
    relevantRootMutations: 0,
    editSyncSnapshotCalls: 0,
    snapshotsInstrumented: false,
    blockTransformCaptureCalls: 0,
    blockTransformOptionsReturned: 0,
    blockTransformIndexProofs: 0,
    blockTransformLegacyProofs: 0,
    indexBuilds: 0,
    postWorkloadIndexBuilds: 0,
    blockHandleSnapshotCalls: 0,
    cacheMetricsInstrumented: false,
    elapsedMs: 0,
    longTaskMaxMs: 0,
    longTasksInstrumented: false,
    rootLuteCalls: 0,
    fragmentLuteCalls: 0,
    maxFragmentInputLength: 0,
    fragmentInputChars: 0,
    luteKinds: {
      liveRoot: 0,
      exact: 0,
      rendered: 0,
      largeOther: 0,
      fragment: 0,
    },
    luteCalls: [],
    getValueTimes: [],
    markerInsertionTimes: [],
    snapshotChanges: [],
    indexBuildChanges: [],
    snapshotChangesInstrumented: false,
    indexBuildChangesInstrumented: false,
    request: {
      observed: false,
      startedAt: 0,
      endedAt: 0,
      elapsedMs: 0,
      fullGetValueCalls: 0,
      rootLuteCalls: 0,
      fragmentLuteCalls: 0,
      markerInsertions: 0,
      editSyncSnapshotCalls: 0,
      indexBuilds: 0,
    },
  })
  let result = fresh()
  let armed = false
  let started = 0
  let ended = 0
  let exactAtStart = ''
  let renderedAtStart = ''
  let rootHtmlLength = 0
  let snapshotBaseline = 0
  let cacheBaseline: Record<string, number> = {}
  const getValue = outer.getValue
  const setValue = outer.setValue
  outer.getValue = function () {
    if (armed && !ended) {
      result.fullGetValueCalls++
      result.getValueTimes.push(performance.now())
    }
    return getValue.call(this)
  }
  outer.setValue = function (...args: unknown[]) {
    if (armed && !ended) result.setValueCalls++
    return setValue.apply(this, args)
  }
  const classify = (input: string, entry: string): TurnIntoLuteKind => {
    if (input === activeRoot()?.innerHTML) return 'liveRoot'
    if (input === exactAtStart) return 'exact'
    if (input === renderedAtStart) return 'rendered'
    const baseline = entry.startsWith('Md2')
      ? exactAtStart.length
      : rootHtmlLength
    return input.length >= baseline / 2 ? 'largeOther' : 'fragment'
  }
  for (const entry of [
    'Md2VditorIRDOM',
    'Md2VditorDOM',
    'VditorIRDOM2Md',
    'VditorDOM2Md',
  ]) {
    const original = inner.lute[entry]
    if (typeof original !== 'function') continue
    inner.lute[entry] = function (...args: unknown[]) {
      if (armed && !ended && typeof args[0] === 'string') {
        const input = args[0]
        const kind = classify(input, entry)
        result.luteCalls.push({
          at: performance.now(),
          entry,
          inputLength: input.length,
          kind,
        })
        result.luteKinds[kind]++
        if (kind === 'fragment') {
          result.fragmentLuteCalls++
          result.fragmentInputChars += input.length
          result.maxFragmentInputLength = Math.max(
            result.maxFragmentInputLength,
            input.length,
          )
        } else result.rootLuteCalls++
      }
      return original.apply(this, args)
    }
  }
  // The private-use prefixes are deliberately escaped so reviews can see the complete match.
  const insert = Range.prototype.insertNode
  Range.prototype.insertNode = function (node: Node) {
    if (
      armed &&
      !ended &&
      activeRoot()?.contains(this.startContainer) &&
      /^[\uE100\uE101]VMDE_REWRAP_(START|END)/u.test(node.textContent ?? '')
    ) {
      result.markerInsertions++
      result.markerInsertionTimes.push(performance.now())
    }
    return insert.call(this, node)
  }
  let postMessageInstrumented = false
  const api = win.vscode
  if (api && !Object.isFrozen(api) && typeof api.postMessage === 'function') {
    const post = api.postMessage
    try {
      api.postMessage = function (message: unknown) {
        if (
          armed &&
          !ended &&
          (message as { command?: string })?.command ===
            'block-transform-options'
        )
          result.optionsPostedCount++
        return post.call(this, message)
      }
      postMessageInstrumented = true
    } catch {
      // A non-frozen API can still expose a read-only method; report unavailable instrumentation.
    }
  }
  const countMutations = (records: MutationRecord[]) => {
    if (!armed || ended) return
    result.relevantRootMutations += records.filter(
      (record) =>
        record.type !== 'attributes' ||
        (![
          'class',
          'style',
          'data-vmde-foldable',
          'data-vmde-list-foldable',
        ].includes(record.attributeName ?? '') &&
          !record.attributeName?.startsWith('aria-')),
    ).length
  }
  const mutations = new MutationObserver(countMutations)
  const longTasksAvailable =
    typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes.includes('longtask')
  const collectLongTasks = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      if (
        entry.startTime >= started &&
        entry.startTime <= (ended || performance.now())
      )
        result.longTaskMaxMs = Math.max(result.longTaskMaxMs, entry.duration)
    }
  }
  const longTasks = longTasksAvailable
    ? new PerformanceObserver((list) => {
        if (armed) collectLongTasks(list.getEntries())
      })
    : undefined
  const cache = () => win.__vmdeBlockHandleCacheMetrics ?? {}
  // Snapshot/build counter setters let the synchronous command be separated from later Details
  // and Find callbacks. Preserve simple data-property behavior; decline accessor interception.
  const watchCounter = (
    object: Record<string, number> | undefined,
    key: string,
    events: 'snapshotChanges' | 'indexBuildChanges',
  ): boolean => {
    if (!object) return false
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (
      descriptor &&
      (!descriptor.configurable || descriptor.get || descriptor.set)
    )
      return false
    let value = object[key] ?? 0
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get: () => value,
      set: (next: number) => {
        if (armed && !ended && next > value)
          result[events].push({ at: performance.now(), delta: next - value })
        value = next
      },
    })
    return true
  }
  const snapshotChangesInstrumented = watchCounter(
    win.__vmdeIncrementalSeedStats,
    'snapshotCalls',
    'snapshotChanges',
  )
  const indexBuildChangesInstrumented = watchCounter(
    win.__vmdeBlockHandleCacheMetrics,
    'indexBuilds',
    'indexBuildChanges',
  )
  const attributeRequest = () => {
    const begin = cache().blockTransformRequestStartedAt ?? 0
    const end = cache().blockTransformRequestEndedAt ?? 0
    if (begin < started || end < begin || begin === 0) return
    const within = (at: number) => at >= begin && at <= end
    const sum = (events: CounterChange[]) =>
      events.reduce(
        (total, event) => total + (within(event.at) ? event.delta : 0),
        0,
      )
    const lute = result.luteCalls.filter((call) => within(call.at))
    result.request = {
      observed: true,
      startedAt: begin,
      endedAt: end,
      elapsedMs: end - begin,
      fullGetValueCalls: result.getValueTimes.filter(within).length,
      rootLuteCalls: lute.filter((call) => call.kind !== 'fragment').length,
      fragmentLuteCalls: lute.filter((call) => call.kind === 'fragment').length,
      markerInsertions: result.markerInsertionTimes.filter(within).length,
      editSyncSnapshotCalls: sum(result.snapshotChanges),
      indexBuilds: sum(result.indexBuildChanges),
    }
  }
  // Freeze action counters before waiting for long-task delivery; later Find repaint or caret
  // work belongs to a separate window and must not inflate synchronous request measurements.
  const finishWorkload = () => {
    if (!armed || ended) return
    countMutations(mutations.takeRecords())
    mutations.disconnect()
    result.editSyncSnapshotCalls =
      (win.__vmdeIncrementalSeedStats?.snapshotCalls ?? 0) - snapshotBaseline
    for (const field of [
      'blockTransformCaptureCalls',
      'blockTransformOptionsReturned',
      'blockTransformIndexProofs',
      'blockTransformLegacyProofs',
      'indexBuilds',
      'blockHandleSnapshotCalls',
    ] as const)
      result[field] = (cache()[field] ?? 0) - (cacheBaseline[field] ?? 0)
    attributeRequest()
    ended = performance.now()
  }
  win.__vmdeTurnIntoProbe = {
    start(exact?: string) {
      if (armed) throw new Error('Turn Into probe already armed')
      // Snapshot/serialization for classifier baselines happens outside the action window.
      exactAtStart =
        exact ??
        win.__vmdeE2EExactMarkdown?.() ??
        win.__exact?.() ??
        outer.getValue()
      renderedAtStart = outer.getValue()
      const root = activeRoot()
      rootHtmlLength = root?.innerHTML.length ?? 0
      result = fresh()
      result.postMessageInstrumented = postMessageInstrumented
      result.snapshotsInstrumented = Boolean(win.__vmdeIncrementalSeedStats)
      result.snapshotChangesInstrumented = snapshotChangesInstrumented
      result.indexBuildChangesInstrumented = indexBuildChangesInstrumented
      result.cacheMetricsInstrumented = Boolean(
        win.__vmdeBlockHandleCacheMetrics,
      )
      result.longTasksInstrumented = longTasksAvailable
      snapshotBaseline = win.__vmdeIncrementalSeedStats?.snapshotCalls ?? 0
      cacheBaseline = { ...cache() }
      mutations.takeRecords()
      mutations.disconnect()
      if (root)
        mutations.observe(root, {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true,
        })
      started = performance.now()
      ended = 0
      longTasks?.observe({ type: 'longtask', buffered: false })
      armed = true
    },
    endWorkload: finishWorkload,
    stop() {
      if (!armed) throw new Error('Turn Into probe is not armed')
      finishWorkload()
      collectLongTasks(longTasks?.takeRecords() ?? [])
      longTasks?.disconnect()
      result.elapsedMs = (ended || performance.now()) - started
      result.postWorkloadIndexBuilds =
        (cache().indexBuilds ?? 0) -
        (cacheBaseline.indexBuilds ?? 0) -
        result.indexBuilds
      armed = false
      return result
    },
  }
}
