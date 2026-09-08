import { createIncrementalMd } from './incremental-md'
import { createPendingEdit } from './pending-edit'
import { innerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import {
  incrementalAdmission,
  undoDelayForContentLength,
  LARGE_DOC_CHARS,
  useIncrementalSerialize,
  type IncrementalAdmission,
  type IncrementalComplexity,
} from './edit-sync-tuning'
import {
  incrementalSeedPreparation,
  sourceComplexitySignature,
  type IncrementalSeedPayload,
} from '../../../src/shared/incremental-admission'
import type { RendererEditPerf } from '../../../src/shared/protocol'
import { setBusyCursor, nextPaint } from '../chrome/busy-cursor'
import { logToHost, reportError } from '../util/webview-log'
import { takeExplicitEdit } from '../links/link-url'
import { trackedEditorRange } from '../editing/editor-caret'

// The debounced edit→host serialize subsystem (task 152 item 1, extracted from
// initVditor). The webview owns the (single) markdown serialize — Vditor no longer
// serializes per input (fixIrInputSerialize patch). On a large doc the serialize is
// multi-second and blocks the thread, so the idle path shows a busy cursor and yields
// a paint before it (task 68); Ctrl/Cmd+S flushes SYNCHRONOUSLY (no yield) so the edit
// is posted before VS Code saves (task 58). Both guard against firing mid
// extension-update / streaming (a partial getValue() would post a truncated document).
//
// Incremental IR serialization (task 69): the full `vditor.getValue()` reserializes the
// whole document (Lute, super-linear) on every idle — seconds on a large doc. For IR we
// instead diff the top-level blocks and re-serialize only what changed, keeping a cached
// full markdown. Proven byte-identical to getValue() (task-69 spike).

/** The live edit-sync controller for one editor instance. */
export interface EditSync {
  /** Schedule a debounced edit→host post (called from Vditor's input()). */
  schedule(): void
  /** Mark that the pending schedule came from a real DOM input. */
  markUserInput(isTrusted?: boolean): void
  /** Flush the pending edit synchronously (Ctrl/Cmd+S, before VS Code saves). */
  flush(): void
  /** Return exact live Markdown without posting it. Large IR documents reuse the incremental
   * authority; unavailable/non-IR cases fall back to Vditor's full serializer. */
  snapshotMarkdown(): string
  /** Return host-exact bytes while the live rendered baseline is still the one derived from them.
   * Genuine local input revokes the pair and falls back to the current production serializer. */
  snapshotExactMarkdown(): string
  /** Flush live Markdown, then ask the host to return its authoritative bytes for rewrap. */
  prepareRewrap(): void
  /** Cancel pending serialization and post known, already-formatted Markdown once. */
  postExact(content: string): void
  /** Drop the incremental IR cache when the DOM is rebuilt outside the edit path
   *  (external setValue / streaming) so the next serialize rebaselines cleanly. */
  invalidate(): void
  /** Replace a stale cache after an external setValue with a fresh host-canonical seed. */
  reseed(seed: IncrementalSeedPayload | undefined, exactMarkdown?: string): void
  /** Post the active large-doc helper set to the host (status-bar marker). */
  reportDocMode(): void
  /** Start post-paint, atomic incremental-cache seeding after the complete IR DOM mounts. */
  startIncrementalSeed(): void
  /** Tear down pending edit/seed work and E2E-only observers for this editor lifecycle. */
  dispose(): void
}

interface EditSyncDeps {
  /** True while an extension-update / streaming is in flight — suppress posts (a
   *  partial getValue() would save a truncated document). Read at call time. */
  isSuppressed: () => boolean
  /** Doc-mode flags fixed for the document's lifetime, for the status-bar marker:
   *  content-visibility (≥100 KB) and streaming (>700 KB) are fixed; incremental
   *  serialization (≥700 blocks) can flip as the user edits (recomputed per report). */
  docMode: { cvActive: boolean; streamActive: boolean; docChars: number }
  incrementalSeed?: IncrementalSeedPayload
  /** Host bytes used to build this editor instance. */
  initialMarkdown?: string
}

interface IncrementalSeedE2EStats {
  state: 'idle' | 'pending' | 'ready' | 'cancelled' | 'error'
  admissionReason: IncrementalAdmission['reason'] | null
  sourceReason: IncrementalSeedPayload['reason'] | null
  hostMs: number
  batches: number
  maxBatchMs: number
  readyMs: number | null
  serializeCalls: number
  snapshotCalls: number
  fullFallbacks: number
  longTasks: number
  maxLongTaskMs: number
}

type IncrementalSeedWindow = Window & {
  __vmdeE2EReadiness?: unknown
  __vmdeIncrementalSeedStats?: IncrementalSeedE2EStats
  __vmdeE2ESnapshotMarkdown?: () => string
  __vmdeE2EExactMarkdown?: () => string
}

function e2eSeedStats(
  hostSeed: IncrementalSeedPayload | undefined,
): IncrementalSeedE2EStats | null {
  const win = window as IncrementalSeedWindow
  if (!win.__vmdeE2EReadiness) return null
  win.__vmdeIncrementalSeedStats = {
    state: 'idle',
    admissionReason: null,
    sourceReason: hostSeed?.reason ?? null,
    hostMs: hostSeed?.hostMs ?? 0,
    batches: 0,
    maxBatchMs: 0,
    readyMs: null,
    serializeCalls: 0,
    snapshotCalls: 0,
    fullFallbacks: 0,
    longTasks: 0,
    maxLongTaskMs: 0,
  }
  return win.__vmdeIncrementalSeedStats
}

function seedMutationAffectsSource(record: MutationRecord): boolean {
  const target =
    record.target.nodeType === Node.ELEMENT_NODE
      ? (record.target as Element)
      : record.target.parentElement
  return !target?.closest(
    '[data-render], .vditor-outline, .vditor-panel, .vditor-toolbar',
  )
}

export function createEditSync(deps: EditSyncDeps): EditSync {
  const { isSuppressed } = deps
  const { cvActive, streamActive, docChars } = deps.docMode
  let hostSeed = deps.incrementalSeed
  const seedStats = e2eSeedStats(hostSeed)
  let seedStartedAt = Number.POSITIVE_INFINITY
  let seedEndedAt = Number.POSITIVE_INFINITY
  let longTaskObserver: PerformanceObserver | undefined
  if (seedStats && typeof PerformanceObserver !== 'undefined') {
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime < seedStartedAt || entry.startTime > seedEndedAt)
            continue
          seedStats.longTasks++
          seedStats.maxLongTaskMs = Math.max(
            seedStats.maxLongTaskMs,
            entry.duration,
          )
        }
      })
      longTaskObserver.observe({ type: 'longtask', buffered: true })
    } catch {
      longTaskObserver = undefined
    }
  }
  let userInputPending = false
  let exactTransactionMarkdown = deps.initialMarkdown ?? null
  let exactTransactionRendered: string | null = null
  const editPerfEnabled = Boolean(
    (window as IncrementalSeedWindow).__vmdeE2EReadiness,
  )
  let editPerfGeneration = 0
  let pendingRendererPerf:
    | {
        id: string
        firstScheduleAt: number
        lastScheduleAt: number
        schedules: number
      }
    | undefined

  const scheduleRendererPerf = (): void => {
    if (!editPerfEnabled) return
    const now = performance.now()
    pendingRendererPerf ??= {
      id: `edit-${++editPerfGeneration}`,
      firstScheduleAt: now,
      lastScheduleAt: now,
      schedules: 0,
    }
    pendingRendererPerf.lastScheduleAt = now
    pendingRendererPerf.schedules++
  }
  const takeRendererPerf = (
    callbackKind: RendererEditPerf['callbackKind'],
  ): RendererEditPerf | undefined => {
    if (!pendingRendererPerf) return undefined
    const now = performance.now()
    const pending = pendingRendererPerf
    pendingRendererPerf = undefined
    return {
      id: pending.id,
      callbackKind,
      schedules: pending.schedules,
      totalWaitMs: now - pending.firstScheduleAt,
      quietWaitMs: now - pending.lastScheduleAt,
      serializeMs: 0,
      payloadBytes: 0,
    }
  }
  const cancelRendererPerf = (): void => {
    const pending = pendingRendererPerf
    pendingRendererPerf = undefined
    if (!pending) return
    vscode.postMessage({
      command: 'edit-perf-renderer',
      id: pending.id,
      postMessageMs: 0,
      state: 'cancelled',
    })
  }
  const cancelTakenRendererPerf = (
    perf: RendererEditPerf | undefined,
  ): void => {
    if (!perf) return
    vscode.postMessage({
      command: 'edit-perf-renderer',
      id: perf.id,
      postMessageMs: 0,
      state: 'cancelled',
    })
  }

  const incrementalIr = createIncrementalMd((html: string) => {
    // `schedule`/`flush` (this closure's only callers) run after Vditor's init has completed —
    // Lute is always present by then. Fail loud rather than silently returning `''` (which would
    // truncate the serialized document) if that invariant is ever broken; `update`'s own
    // try/catch (incremental-md.ts) treats a throw here as a self-heal signal, same as its
    // internal consistency checks.
    const lute = innerVditor()?.lute
    if (!lute) throw new Error('edit-sync: Lute not initialized')
    if (seedStats) seedStats.serializeCalls++
    return lute.VditorIRDOM2Md(html)
  })
  const irElement = (): HTMLElement | undefined => innerVditor()?.ir?.element
  const irBlocks = (el: HTMLElement): HTMLElement[] =>
    Array.from(el.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.hasAttribute('data-block'),
    )
  const irTopBlocks = (el: HTMLElement): string[] =>
    irBlocks(el).map((block) => block.outerHTML)
  const irComplexity = (el: HTMLElement): IncrementalComplexity => ({
    chars: hostSeed?.source.chars ?? docChars,
    lines: hostSeed?.source.lines ?? 0,
    blocks: irBlocks(el).length,
    descendants: el.querySelectorAll('*').length,
    listItems: el.querySelectorAll('li').length,
    tables: el.querySelectorAll('table').length,
    inlineRich: el.querySelectorAll('strong, em, a, code').length,
  })
  // Cache is IR-only; re-entering IR (after a mode switch) rebaselines.
  let lastSerializeMode: string | null = null
  let measuredAdmission: IncrementalAdmission | undefined
  let seedState: 'idle' | 'pending' | 'ready' | 'cancelled' | 'error' = 'idle'
  let exactSeedOwned = Boolean(hostSeed)
  let seedFrame = 0
  let seedObserver: MutationObserver | undefined
  let activeSeed: ReturnType<typeof incrementalIr.beginSeed> | undefined

  const cancelSeed = (state: 'cancelled' | 'idle' = 'cancelled') => {
    if (seedFrame) cancelAnimationFrame(seedFrame)
    seedFrame = 0
    seedObserver?.disconnect()
    seedObserver = undefined
    activeSeed?.cancel()
    activeSeed = undefined
    if (seedState === 'pending') {
      seedState = state
      seedEndedAt = performance.now()
      if (seedStats) seedStats.state = state
    }
  }
  const retryExactSeedAfterPaint = (): void => {
    if (!exactSeedOwned || !hostSeed) return
    seedFrame = requestAnimationFrame(() => {
      seedFrame = 0
      if (
        exactSeedOwned &&
        hostSeed &&
        window.vditor.getCurrentMode?.() === 'ir'
      )
        startIncrementalSeed()
    })
  }
  const isLargeDoc = () =>
    (activeModeElement(window.vditor)?.textContent?.length ?? 0) >=
    LARGE_DOC_CHARS
  // The incremental serializer pays off only with enough top-level blocks — block COUNT
  // (not byte size) drives the super-linear full-serialize cost (task-69 analysis). Returns
  // the IR element when incremental should be used, else undefined (→ plain getValue()).
  // `children.length` is O(1) and correct for code/lists/tables (each is one block).
  const irIncrementalElement = (): HTMLElement | undefined => {
    const el = irElement()
    if (window.vditor.getCurrentMode?.() !== 'ir') return undefined
    const enabled = el
      ? (measuredAdmission?.enabled ??
        useIncrementalSerialize(
          window.vditor.getCurrentMode?.(),
          irBlocks(el).length,
        ))
      : false
    return el && enabled ? el : undefined
  }
  const serializeSvForHost = (): string => {
    const editor = activeModeElement(window.vditor)
    if (!editor) return vditor.getValue()
    // Vditor always appends one editable newline span to SV. Remove that DOM node, rather than
    // trimming text: authored terminal blank lines are their preceding sibling spans and remain.
    const clone = editor.cloneNode(true) as HTMLElement
    clone
      .querySelector(
        ':scope > [data-block]:last-child > [data-type="newline"]:last-child',
      )
      ?.remove()
    return (clone.textContent ?? '').replace(/\u200B(?=\n*$)/gu, '')
  }
  const serializeForHost = (): string => {
    const el = irIncrementalElement()
    if (el) {
      if (seedState === 'pending') {
        if (seedStats) seedStats.fullFallbacks++
        return vditor.getValue()
      }
      if (lastSerializeMode !== 'ir-incremental') incrementalIr.invalidate()
      lastSerializeMode = 'ir-incremental'
      return incrementalIr.update(irTopBlocks(el))
    }
    const mode = window.vditor.getCurrentMode?.() ?? null
    lastSerializeMode = mode
    if (mode === 'sv') return serializeSvForHost()
    return vditor.getValue()
  }
  const snapshotMarkdown = (): string => {
    if (seedStats) seedStats.snapshotCalls++
    return serializeForHost()
  }
  const snapshotExactMarkdown = (): string => {
    const rendered = snapshotMarkdown()
    if (exactTransactionMarkdown === null) return rendered
    if (exactTransactionRendered === null) exactTransactionRendered = rendered
    if (rendered === exactTransactionRendered) return exactTransactionMarkdown
    exactTransactionMarkdown = null
    exactTransactionRendered = null
    return rendered
  }
  if (seedStats) {
    ;(window as IncrementalSeedWindow).__vmdeE2ESnapshotMarkdown =
      snapshotMarkdown
    ;(window as IncrementalSeedWindow).__vmdeE2EExactMarkdown =
      snapshotExactMarkdown
  }

  // Report which large-document helpers are active to the host. Post only when the
  // active SET changes, so it's cheap to call often.
  let lastReportedSig: string | null = null
  const reportDocMode = (): void => {
    const incremental =
      irIncrementalElement() !== undefined && seedState !== 'pending'
    const currentIr = irElement()
    const blocks = currentIr ? irBlocks(currentIr).length : 0
    const sig = `${cvActive}|${streamActive}|${incremental}`
    if (sig === lastReportedSig) return
    lastReportedSig = sig
    vscode.postMessage({
      command: 'docMode',
      contentVisibility: cvActive,
      streaming: streamActive,
      incremental,
      blocks,
      chars: docChars,
    })
  }

  const startIncrementalSeed = (): void => {
    cancelSeed('idle')
    const owner = irElement()
    if (!owner) return
    if (!hostSeed) {
      seedState = 'idle'
      if (seedStats) {
        seedStats.state = 'idle'
        seedStats.admissionReason = incrementalAdmission(
          window.vditor.getCurrentMode?.(),
          irBlocks(owner).length,
        ).reason
      }
      return
    }
    seedState = 'pending'
    let seedStarted = 0
    seedEndedAt = Number.POSITIVE_INFINITY
    const seedBlocks: string[] = []
    let blockElements: HTMLElement[] = []
    let captureIndex = 0
    let initialized = false
    let paintFrames = 4
    if (seedStats) {
      seedStats.state = 'pending'
      seedStats.longTasks = 0
      seedStats.maxLongTaskMs = 0
    }
    seedObserver = new MutationObserver((records) => {
      if (!records.some(seedMutationAffectsSource)) return
      // Vditor can finish a setValue/exact-format rebuild in later microtasks. Those mutations
      // still describe the host seed and may restart after quiet; a trusted user input revokes
      // exactSeedOwned before the observer callback and must cancel the now-stale seed.
      const retryExactRebuild = exactSeedOwned && hostSeed !== undefined
      cancelSeed()
      if (retryExactRebuild) retryExactSeedAfterPaint()
    })
    seedObserver.observe(owner, {
      characterData: true,
      childList: true,
      subtree: true,
    })
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one frame owns stale-owner checks, deadline stepping, metrics, and atomic completion for the seed state machine.
    const tick = () => {
      seedFrame = 0
      if (
        seedState !== 'pending' ||
        irElement() !== owner ||
        window.vditor.getCurrentMode?.() !== 'ir'
      ) {
        const retryOwnerSwap =
          exactSeedOwned &&
          hostSeed !== undefined &&
          window.vditor.getCurrentMode?.() === 'ir'
        cancelSeed()
        if (retryOwnerSwap) retryExactSeedAfterPaint()
        return
      }
      if (paintFrames > 0) {
        paintFrames--
        seedFrame = requestAnimationFrame(tick)
        return
      }
      const started = performance.now()
      if (!seedStarted) {
        seedStarted = started
        seedStartedAt = Math.max(0, started - 1)
      }
      if (!initialized) {
        measuredAdmission = incrementalAdmission('ir', irComplexity(owner))
        blockElements = irBlocks(owner)
        if (seedStats) seedStats.admissionReason = measuredAdmission.reason
        initialized = true
        if (!measuredAdmission.enabled || !hostSeed) {
          seedState = 'idle'
          seedEndedAt = performance.now()
        }
      }
      while (
        seedState === 'pending' &&
        captureIndex < blockElements.length &&
        performance.now() - started < 4
      ) {
        seedBlocks.push(blockElements[captureIndex].outerHTML)
        captureIndex++
      }
      if (
        seedState === 'pending' &&
        captureIndex === blockElements.length &&
        !activeSeed
      )
        activeSeed = incrementalIr.beginSeed(seedBlocks, hostSeed!.markdown)
      let status = activeSeed?.status ?? seedState
      while (
        status === 'pending' &&
        activeSeed &&
        performance.now() - started < 4
      )
        status = activeSeed.step(1)
      if (seedStats) {
        seedStats.batches++
        seedStats.maxBatchMs = Math.max(
          seedStats.maxBatchMs,
          performance.now() - started,
        )
      }
      if (seedState === 'pending' && status === 'pending') {
        seedFrame = requestAnimationFrame(tick)
        return
      }
      seedObserver?.disconnect()
      seedObserver = undefined
      activeSeed = undefined
      seedState = status
      seedEndedAt = performance.now()
      exactSeedOwned = false
      if (seedState === 'ready') lastSerializeMode = 'ir-incremental'
      if (seedStats) {
        seedStats.state = seedState
        if (seedState === 'ready')
          seedStats.readyMs = performance.now() - seedStarted
      }
      lastReportedSig = null
      reportDocMode()
    }
    seedFrame = requestAnimationFrame(tick)
    lastReportedSig = null
    reportDocMode()
  }

  const replaceIncrementalSeed = (
    seed: IncrementalSeedPayload | undefined,
  ): void => {
    cancelSeed()
    incrementalIr.invalidate()
    hostSeed = seed
    exactSeedOwned = Boolean(seed)
    measuredAdmission = undefined
    lastSerializeMode = null
    ;(window as any).__vmdeInvalidatePreview?.('content')
    if (seedStats) {
      seedStats.state = 'idle'
      seedStats.admissionReason = null
      seedStats.sourceReason = seed?.reason ?? null
      seedStats.hostMs = seed?.hostMs ?? 0
      seedStats.batches = 0
      seedStats.maxBatchMs = 0
      seedStats.readyMs = null
      seedStats.longTasks = 0
      seedStats.maxLongTaskMs = 0
    }
    if (seed) startIncrementalSeed()
    else {
      lastReportedSig = null
      reportDocMode()
    }
  }

  const seedFromExactMarkdown = (
    content: string,
  ): IncrementalSeedPayload | undefined => {
    if (window.vditor.getCurrentMode?.() !== 'ir') return undefined
    const source = sourceComplexitySignature(content)
    const preparation = incrementalSeedPreparation(source)
    if (!preparation.prepare || preparation.reason === 'ordinary')
      return undefined
    return {
      markdown: content,
      source,
      reason: preparation.reason,
      hostMs: 0,
    }
  }

  // Keep Vditor's idle window mode-aware (Vditor reads options.undoDelay live). IR/SV
  // stay snappy (task 69: IR is incremental, SV serialize is trivial); only WYSIWYG, whose
  // full VditorDOM2Md is still super-linear, widens on large docs. Re-evaluated per edit so
  // a mode switch takes effect on the next edit's scheduling.
  const syncUndoDelay = () => {
    const inner = innerVditor()
    if (!inner?.options) return
    const mode = window.vditor.getCurrentMode?.()
    const len =
      mode === 'wysiwyg'
        ? (activeModeElement(window.vditor)?.textContent?.length ?? 0)
        : 0
    inner.options.undoDelay = undoDelayForContentLength(len, mode)
  }

  // Task 390: the markdown of the top-level block the caret sits in, for an EXPLICIT markup action
  // (the link button turning a selected URL into `[url](url)`). That result is semantically identical
  // to the bare URL already on disk — GFM autolinks it — so the host's minimal-diff write-back would
  // correctly keep the original bytes and the button would leave the file untouched. Sending the one
  // block lets the host rewrite exactly that block and nothing else; the general no-op rule, which is
  // what stops an edit reflowing untouched blocks, stays intact. Best-effort: undefined ⇒ the host
  // behaves exactly as before.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: best-effort single-block-source extraction across the IR/WYSIWYG DOM-shape branches; pre-existing (task 469 baseline)
  const explicitBlockMd = (): string | undefined => {
    try {
      const editor = activeModeElement(window.vditor)
      const sel = window.getSelection()
      const live = sel?.rangeCount ? sel.getRangeAt(0).startContainer : null
      // WYSIWYG's link button opens a popover and focuses its input, so the LIVE selection is no
      // longer in the editor by the time this runs — fall back to the caret editor-caret.ts tracks.
      const node =
        live && editor?.contains(live)
          ? live
          : (trackedEditorRange()?.startContainer ?? null)
      if (!editor || !node || !editor.contains(node)) return undefined
      // The top-level block is the editor's own child that contains the caret.
      let block = (
        node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
      ) as HTMLElement | null
      while (block && block.parentElement !== editor)
        block = block.parentElement
      if (!block) return undefined
      // Mode-aware: WYSIWYG's DOM is not IR's, and serializing it with VditorIRDOM2Md yields
      // markdown that matches nothing on the host, so the explicit block is silently dropped.
      const lute = innerVditor()?.lute
      const md =
        window.vditor.getCurrentMode?.() === 'wysiwyg'
          ? lute?.VditorDOM2Md(block.outerHTML)
          : lute?.VditorIRDOM2Md(block.outerHTML)
      return md?.trim() ? md : undefined
    } catch {
      return undefined
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: existing mode/exact/explicit correctness branches plus E2E-only stage annotations stay in one atomic post path.
  const postEdit = (perf?: RendererEditPerf) => {
    const currentMode = window.vditor.getCurrentMode?.() ?? null
    const previousMode =
      lastSerializeMode === 'ir-incremental' ? 'ir' : lastSerializeMode
    if (!userInputPending && exactSeedOwned) {
      cancelTakenRendererPerf(perf)
      return
    }
    if (
      !userInputPending &&
      previousMode !== null &&
      currentMode !== previousMode
    ) {
      // Vditor fires input while switching render modes. Rebaseline the IR authority during the
      // transition, but never post mode-canonicalized bytes for a document the user did not edit.
      serializeForHost()
      reportDocMode()
      syncUndoDelay()
      cancelTakenRendererPerf(perf)
      return
    }
    const explicitBlock = takeExplicitEdit(window)
      ? explicitBlockMd()
      : undefined
    const serializeStarted = performance.now()
    const content = serializeForHost()
    if (perf) {
      perf.serializeMs = performance.now() - serializeStarted
      perf.payloadBytes = new TextEncoder().encode(content).length
    }
    const postStarted = performance.now()
    vscode.postMessage({
      command: 'edit',
      content,
      explicitBlock,
      ...(perf ? { perf } : {}),
    })
    if (perf)
      vscode.postMessage({
        command: 'edit-perf-renderer',
        id: perf.id,
        postMessageMs: performance.now() - postStarted,
        state: 'posted',
      })
    userInputPending = false
    reportDocMode()
    syncUndoDelay()
  }
  const pendingEdit = createPendingEdit({
    wait: 250,
    onIdle: async () => {
      const perf = takeRendererPerf('idle')
      if (isSuppressed()) {
        cancelTakenRendererPerf(perf)
        return
      }
      // A postEdit() throw (e.g. a Lute serialize failure) must not become an unhandled
      // rejection: pending-edit.ts's setTimeout callback fires this without awaiting it
      // (task 482, noFloatingPromises) — without this catch, an exception here would
      // silently kill this idle cycle's host sync with no trace anywhere.
      try {
        // IR is now incremental → fast even on large docs (no busy cursor). WYSIWYG/SV
        // still do a full getValue(); keep the busy-cursor + paint for that slow path.
        if (window.vditor.getCurrentMode?.() !== 'ir' && isLargeDoc()) {
          setBusyCursor(true)
          await nextPaint() // let the busy cursor paint before the long serialize
          try {
            postEdit(perf)
          } finally {
            setBusyCursor(false)
          }
        } else {
          postEdit(perf)
        }
      } catch (err) {
        reportError(err, 'edit-sync: onIdle')
      }
    },
    onFlush: () => flushEdit(false, takeRendererPerf('flush')),
  })

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: authoritative save auditing and E2E-only timing must cover the same indivisible flush branches.
  function flushEdit(rewrapDocument = false, perf?: RendererEditPerf): void {
    if (isSuppressed()) {
      cancelTakenRendererPerf(perf)
      return
    }
    const serializeStarted = performance.now()
    // Save is authoritative (task 58): on a large IR doc bring the incremental cache
    // current (cheap), then audit it against a full getValue() — drift = a fast-path bug,
    // log + resync so a bad incremental result can never corrupt a saved file. Small docs
    // (below the block-count gate) serialize directly.
    const incrEl = irIncrementalElement()
    if (incrEl) {
      const incremental = incrementalIr.update(irTopBlocks(incrEl))
      const authoritative = vditor.getValue()
      if (incremental !== authoritative) {
        logToHost(
          '[task69] incremental IR markdown drifted from full serialize on save; using authoritative + resyncing',
        )
        incrementalIr.invalidate()
      }
      const content = authoritative
      if (perf) {
        perf.serializeMs = performance.now() - serializeStarted
        perf.payloadBytes = new TextEncoder().encode(content).length
      }
      const postStarted = performance.now()
      vscode.postMessage({
        command: 'edit',
        content,
        rewrapDocument,
        ...(perf ? { perf } : {}),
      })
      if (perf)
        vscode.postMessage({
          command: 'edit-perf-renderer',
          id: perf.id,
          postMessageMs: performance.now() - postStarted,
          state: 'posted',
        })
    } else {
      const content = serializeForHost()
      if (perf) {
        perf.serializeMs = performance.now() - serializeStarted
        perf.payloadBytes = new TextEncoder().encode(content).length
      }
      const postStarted = performance.now()
      vscode.postMessage({
        command: 'edit',
        content,
        rewrapDocument,
        ...(perf ? { perf } : {}),
      })
      if (perf)
        vscode.postMessage({
          command: 'edit-perf-renderer',
          id: perf.id,
          postMessageMs: performance.now() - postStarted,
          state: 'posted',
        })
    }
    userInputPending = false
  }

  return {
    schedule: () => {
      scheduleRendererPerf()
      pendingEdit.schedule()
    },
    markUserInput: (isTrusted = true) => {
      // Programmatic setValue emits an untrusted input while its known exact seed is settling.
      // A trusted keyboard/paste edit always revokes that ownership; other synthetic editor
      // actions still count as input when no exact transaction owns the rebuild.
      if (isTrusted) {
        userInputPending = true
        exactSeedOwned = false
        exactTransactionMarkdown = null
        exactTransactionRendered = null
      }
    },
    flush: () => pendingEdit.flush(),
    snapshotMarkdown,
    snapshotExactMarkdown,
    prepareRewrap: () => {
      pendingEdit.cancel()
      if (userInputPending) flushEdit(true, takeRendererPerf('flush'))
      else vscode.postMessage({ command: 'request-rewrap-document' })
    },
    postExact: (content) => {
      pendingEdit.cancel()
      cancelRendererPerf()
      // The exact transaction supersedes the triggering input. Clear this before starting the
      // seed so delayed setValue mutations are recognized as the same exact rebuild, not a new edit.
      userInputPending = false
      exactTransactionMarkdown = content
      exactTransactionRendered = null
      replaceIncrementalSeed(seedFromExactMarkdown(content))
      if (isSuppressed()) return
      vscode.postMessage({ command: 'edit', content, exact: true })
      syncUndoDelay()
    },
    invalidate: () => {
      cancelRendererPerf()
      cancelSeed()
      exactSeedOwned = false
      incrementalIr.invalidate()
      ;(window as any).__vmdeInvalidatePreview?.('content')
    },
    reseed: (seed, exactMarkdown) => {
      exactTransactionMarkdown = exactMarkdown ?? seed?.markdown ?? null
      exactTransactionRendered = null
      replaceIncrementalSeed(seed)
    },
    reportDocMode,
    startIncrementalSeed,
    dispose: () => {
      pendingEdit.cancel()
      cancelRendererPerf()
      cancelSeed()
      exactSeedOwned = false
      exactTransactionMarkdown = null
      exactTransactionRendered = null
      incrementalIr.invalidate()
      longTaskObserver?.disconnect()
      longTaskObserver = undefined
      if (seedStats)
        delete (window as IncrementalSeedWindow).__vmdeE2ESnapshotMarkdown
      if (seedStats)
        delete (window as IncrementalSeedWindow).__vmdeE2EExactMarkdown
    },
  }
}
