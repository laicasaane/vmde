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
// a paint before it (task 68); the host's will-save flush (task 58, Task 580 CP2-12) runs
// SYNCHRONOUSLY (no yield) so the edit is posted before VS Code writes the document. Both guard against firing mid
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
  /** Flush the pending edit synchronously (the host's will-save `flush-for-save`). */
  flush(): void
  /** Task 601: before an Undo/Redo transition, post a still-scheduled edit now, with the same
   * exact-source rules as `flush`. Posts nothing when no edit is scheduled. Returns whether one was. */
  flushHistoryInput(): boolean
  /** Task 628 (R2): whether `rendered` (the live document as `edit` posts carry it) renders like
   * the text the host holds, so an undo boundary has nothing to publish. The host's own semantic
   * no-op test: both texts through Lute's IR round trip, equal up to trailing newlines. False when the host text is unknown, the document is large, or Lute is missing. */
  equivalentToHost(rendered: string): boolean
  /** Task 602: the live document in the text form `edit` posts use (SV without Vditor's trailing
   * editable newline, otherwise `getValue()`), so history messages compare with published edits. */
  historyText(): string
  /** Settle typing for a guarded block action while retaining owned exact bytes after Undo. */
  settleBlockActionInput(): void
  /** Return exact live Markdown without posting it. Large IR documents reuse the incremental
   * authority; unavailable/non-IR cases fall back to Vditor's full serializer. */
  snapshotMarkdown(): string
  /** Return host-exact bytes while this webview owns them (Task 607 INV-A); `null` when no owned
   * pair describes the live rendering. Rendered bytes are never promoted to exact authority. */
  snapshotExactMarkdown(): string | null
  /** Exact bytes plus the rendered serialization computed by the same call. `rendered` is what
   * `snapshotMarkdown()` returns, so a consumer that needs both pays one serialization. `exact`
   * follows the `snapshotExactMarkdown` rules. */
  snapshotPair(): { exact: string | null; rendered: string }
  /** Task 607: resolve an owned pair at once, or settle typing and pull the host's bytes, adopting
   * them only with a rendering proof. `null` after 1.5 s or without proof: the caller declines.
   * `background` (display consumers) never flushes typing: pending typing first publishes on its
   * own debounce, so a display read cannot split one host Undo step into two. */
  acquireExactAuthority(opts?: {
    publish?: boolean
    background?: boolean
  }): Promise<{ exact: string; rendered: string } | null>
  /** Task 607: an exact action's own apply window (its setValue before `postExact`). Only here
   * does a rendering change keep the owned base; streaming and host updates are not this window.
   * Entering it with typing pending and no owned base publishes that typing as a plain edit first,
   * so a refused action rolls back to host text that still holds it. */
  setActionApplying(applying: boolean): void
  /** Host reply to `request-exact-authority`; stale request ids are ignored. */
  receiveExactAuthority(message: { requestId: string; content: string }): void
  /** Host refusal of a guarded exact edit (Task 607 INV-B); acts only for the latest request. */
  receiveExactRefusal(message: { requestId?: string; content: string }): void
  /** Record a DOM change edit-sync did not schedule (Vditor's undo/redo engine), so an unanchored
   * exact transaction proves its bytes against the live DOM before trusting them. */
  markEditorChange(): void
  /** Stable opaque identity for the current exact-source authority. */
  snapshotRevision(): object
  /** Flush live Markdown, then ask the host to return its authoritative bytes for rewrap. */
  prepareRewrap(): void
  /** Cancel pending serialization and post known, already-formatted Markdown once. The edit names
   * the host bytes it replaces (`before`, default: the last owned base); without one the host
   * refuses it. A refusal rolls the DOM back unless `rollback` is `false`. */
  postExact(content: string, opts?: PostExactOptions): void
  /** Drop the incremental IR cache when the DOM is rebuilt outside the edit path
   *  (external setValue / streaming) so the next serialize rebaselines cleanly. */
  invalidate(): void
  /** Replace a stale cache after an external setValue with a fresh host-canonical seed. */
  reseed(seed: IncrementalSeedPayload | undefined, exactMarkdown?: string): void
  /** Post the active large-doc helper set to the host (status-bar marker). */
  reportDocMode(): void
  /** Start post-paint, atomic incremental-cache seeding after the complete IR DOM mounts. */
  startIncrementalSeed(): void
  /** Task 641: the host seed posted after `init` for the host bytes `content`; dropped unless this
   *  editor still shows exactly those bytes, untouched and without a seed of its own. */
  receiveDeferredSeed(seed: IncrementalSeedPayload, content: string): void
  /** Tear down pending edit/seed work and E2E-only observers for this editor lifecycle. */
  dispose(): void
}

/** Restores what an exact action changed besides the DOM (table Undo stacks, its document-history
 * entry) when the host refuses the action's edit. */
interface ExactRollback {
  restore(): void
}

interface PostExactOptions {
  /** The caller's rollback handle, or `false` to keep the DOM on a refusal (history replays). */
  rollback?: ExactRollback | false
  /** The host bytes this edit replaces, when the caller knows them better than the owned base. */
  before?: string
}

const EXACT_AUTHORITY_TIMEOUT_MS = 1500

const normalizeEol = (text: string): string => text.replace(/\r\n?/g, '\n')

interface EditSyncDeps {
  /** True while an extension-update / streaming is in flight — suppress posts (a
   *  partial getValue() would save a truncated document). Read at call time. */
  isSuppressed: () => boolean
  /** Enter or leave the applying state while a refused exact edit is rolled back. */
  setApplying?: (value: boolean) => void
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
  __vmdeE2EExactMarkdown?: () => string | null
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

// Task 628 (R2): the host skips a whole-document semantic no-op (`isSemanticNoop`): both texts go
// through the same reserialize and compare equal up to trailing newlines. The webview mirrors it
// with `project` (Lute's IR round trip, as the host's), so an undo boundary can tell that its state
// adds nothing the host does not already hold. Past this size the host's own check declines
// (MINDIFF_CAP) and the boundary publishes as before.
const EQUIVALENCE_CAP = 100_000
const withoutTrailingNewlines = (text: string): string =>
  text.replace(/\r\n/g, '\n').replace(/\n+$/, '')

export function renderedStatesEquivalent(
  project: (markdown: string) => string | null,
  hostText: string,
  rendered: string,
): boolean {
  if (hostText.length > EQUIVALENCE_CAP || rendered.length > EQUIVALENCE_CAP)
    return false
  const held = project(hostText)
  if (held === null) return false
  const live = rendered === held ? held : project(rendered)
  return (
    live !== null &&
    withoutTrailingNewlines(held) === withoutTrailingNewlines(live)
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
  // The edit mode whose serialization anchored `exactTransactionRendered`.
  let anchorMode: string | null = null
  // The rendered baseline of an exact transaction is anchored lazily, at the first snapshot, so
  // opening or posting exact bytes costs no serialization. An untrusted editor edit (toolbar or
  // selection formatting) does not revoke ownership, so if one lands before that first snapshot,
  // the edited DOM must not be anchored to the pre-edit bytes (Task 574: passive selection no
  // longer snapshots on every selection change, which used to anchor early by accident).
  let editBeforeAnchor = false
  // Task 607 INV-A. `hostBase`: the bytes the host holds, in message-queue order (null once a plain
  // edit is posted, since the host minimizes those). `remembered`: the pair a trusted input revoked,
  // which a later rendering may prove again (an Undo) or rebase onto (unpublished typing).
  // `ownedBase`: the base of the last owned pair handed out; an exact post names it as `before`.
  let hostBase: string | null = deps.initialMarkdown ?? null
  // Task 628 (R2): the text the host holds, as far as the webview knows it: `hostBase` while known
  // exactly, otherwise the last plain post (the host minimized it against its own bytes, so it
  // holds a text that renders like the post).
  let hostReference: string | null = deps.initialMarkdown ?? null
  // The projection of the reference, kept so repeated boundaries project it once.
  let projectedReference: {
    source: string
    mode: string | null
    projected: string | null
  } | null = null
  let remembered: { exact: string; rendered: string | null } | null = null
  let ownedBase: string | null = deps.initialMarkdown ?? null
  // The one-span rebase result for the last rendering, so repeated reads reuse its projection.
  let lastRebase: { rendered: string; exact: string | null } | null = null
  let trustedInputs = 0
  let nextRequest = 0
  const newRequestId = (): string => `exact-${Date.now()}-${++nextRequest}`
  let latestExact: {
    requestId: string
    rollback: ExactRollback | false | undefined
    plainAfter: boolean
  } | null = null
  // Background acquires waiting for pending typing to publish on its own debounce. Each one gives
  // up after the same 1.5 s as an authority request.
  let backgroundWaiters: Array<{
    resolve(value: { exact: string; rendered: string } | null): void
    timer: ReturnType<typeof setTimeout>
  }> = []
  const settleBackgroundWaiters = (
    result: Promise<{ exact: string; rendered: string } | null> | null,
  ): void => {
    const waiters = backgroundWaiters
    backgroundWaiters = []
    const settled = result ?? Promise.resolve(null)
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      void settled.then((value) => waiter.resolve(value))
    }
  }
  // The explicit apply window of an exact action (see `setActionApplying`).
  let actionApplying = false
  let authorityRequest: {
    requestId: string
    rendered: string
    trustedInputs: number
    promise: Promise<{ exact: string; rendered: string } | null>
    resolve(value: { exact: string; rendered: string } | null): void
    timer: ReturnType<typeof setTimeout>
  } | null = null
  // A revision is identity-only: presentation caches compare it without serializing or hashing Markdown.
  let sourceRevision: object = {}
  const advanceSourceRevision = (): void => {
    sourceRevision = {}
  }
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
  // Task 641: an editor built without a seed can still take the one the host posts after `init`,
  // until anything changes the document or its authority (any edit, exact post, Undo-engine change,
  // rebuild, reseed or invalidation). Until then edits keep the unseeded path.
  let deferredSeedOpen = !hostSeed
  // Whether the mount already asked for seeding; a deferred seed that arrives later starts it.
  let seedStartRequested = false
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
  const serializeSvForHost = (
    editor = activeModeElement(window.vditor),
  ): string => {
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
  // Lute's render/serialize pair for the active visual mode; null without a visual projection.
  const visualProjection = (): ((exact: string) => string) | null => {
    const lute = innerVditor()?.lute
    const mode = window.vditor.getCurrentMode?.()
    const render =
      mode === 'ir'
        ? lute?.Md2VditorIRDOM
        : mode === 'wysiwyg'
          ? lute?.Md2VditorDOM
          : undefined
    const serialize =
      mode === 'ir'
        ? lute?.VditorIRDOM2Md
        : mode === 'wysiwyg'
          ? lute?.VditorDOM2Md
          : undefined
    if (typeof render !== 'function' || typeof serialize !== 'function')
      return null
    return (exact) => serialize.call(lute, render.call(lute, exact))
  }
  // True when `rendered` is Lute's rendering of `exact` in the active visual mode: the same
  // projection proof the block handle relies on. Without a visual projection (SV, or no Lute),
  // keep the previous anchoring.
  const renderedFromExact = (exact: string, rendered: string): boolean => {
    const project = visualProjection()
    if (!project) return true
    try {
      return project(exact) === rendered
    } catch {
      return false
    }
  }
  // The rendered Markdown a mode's own DOM holds, even while hidden: Vditor keeps every mode's
  // element when it switches and only toggles its display.
  const serializeModeDom = (mode: string): string | null => {
    const inner = innerVditor()
    const lute = inner?.lute
    try {
      if (mode === 'ir' && inner?.ir?.element)
        return lute?.VditorIRDOM2Md?.(inner.ir.element.innerHTML) ?? null
      if (mode === 'wysiwyg' && inner?.wysiwyg?.element)
        return lute?.VditorDOM2Md?.(inner.wysiwyg.element.innerHTML) ?? null
      if (mode === 'sv' && inner?.sv?.element)
        return serializeSvForHost(inner.sv.element)
    } catch {
      return null
    }
    return null
  }
  // Task 196: a mode switch re-renders the same document in another mode's canonical Markdown.
  // Revoking exact ownership there made Find (and every exact action) plan on normalized bytes after
  // any switch. With nothing typed since, and the previous mode's DOM still serializing to the
  // anchored text (no untrusted edit before the switch), the exact bytes still describe the
  // document: re-anchor them to the new mode's rendering.
  const reanchorAfterModeSwitch = (rendered: string): void => {
    const mode = window.vditor.getCurrentMode?.() ?? null
    if (
      exactTransactionRendered === null ||
      anchorMode === null ||
      mode === null ||
      mode === anchorMode ||
      userInputPending ||
      rendered === exactTransactionRendered ||
      serializeModeDom(anchorMode) !== exactTransactionRendered
    )
      return
    exactTransactionRendered = rendered
    anchorMode = mode
  }
  // Task 607: the rendering the active mode derives from `exact`, or null when it cannot be
  // computed. Unlike `renderedFromExact`, a missing projection proves nothing. SV shows the source
  // itself, so its projection is the text with normalized line endings.
  const projectRendered = (exact: string): string | null => {
    if (window.vditor.getCurrentMode?.() === 'sv') return normalizeEol(exact)
    const project = visualProjection()
    try {
      return project ? project(exact) : null
    } catch {
      return null
    }
  }
  // Task 628 (R2): the projection the host's semantic no-op test uses, whatever mode is active. The
  // host reserializes through Lute's IR round trip (`canonicalIrMarkdown`), which keeps a table
  // cell's `<br />` where the WYSIWYG round trip drops it; SV shows the source itself.
  const projectLikeHost = (markdown: string): string | null => {
    if (window.vditor.getCurrentMode?.() === 'sv') return normalizeEol(markdown)
    const lute = innerVditor()?.lute
    if (
      typeof lute?.Md2VditorIRDOM !== 'function' ||
      typeof lute.VditorIRDOM2Md !== 'function'
    )
      return null
    try {
      return lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(markdown))
    } catch {
      return null
    }
  }
  const provesExact = (exact: string, rendered: string): boolean =>
    projectRendered(exact) === rendered
  const rememberedRendering = (): string | null => {
    if (!remembered) return null
    remembered.rendered ??= projectRendered(remembered.exact)
    return remembered.rendered
  }
  // D3: map unpublished typing onto the bytes the host still holds. The typing is the one span
  // where the remembered rendering and the live rendering differ; its old bytes must appear
  // unchanged in the exact source at an identical prefix or suffix, so no normalized bytes outside
  // the span are carried along. The result stands only when it renders to the live rendering.
  const rebaseUnpublished = (rendered: string): string | null => {
    if (!remembered || remembered.exact !== hostBase) return null
    if (lastRebase?.rendered === rendered) return lastRebase.exact
    const before = rememberedRendering()
    const exact = before === null ? null : rebaseOneSpan(before, rendered)
    lastRebase = { rendered, exact }
    return exact
  }
  // Where `oldSpan` sits in `source`: after an identical prefix, or before an identical suffix.
  const anchorSpan = (
    source: string,
    before: string,
    prefix: number,
    suffix: number,
    oldSpan: string,
  ): number => {
    if (
      source.startsWith(before.slice(0, prefix)) &&
      source.startsWith(oldSpan, prefix)
    )
      return prefix
    const end = source.length - suffix
    const start = end - oldSpan.length
    return start >= 0 &&
      source.endsWith(before.slice(before.length - suffix)) &&
      source.slice(start, end) === oldSpan
      ? start
      : -1
  }
  const rebaseOneSpan = (before: string, rendered: string): string | null => {
    const source = remembered!.exact
    const limit = Math.min(before.length, rendered.length)
    let prefix = 0
    while (prefix < limit && before[prefix] === rendered[prefix]) prefix++
    let suffix = 0
    while (
      suffix < limit - prefix &&
      before[before.length - 1 - suffix] ===
        rendered[rendered.length - 1 - suffix]
    )
      suffix++
    const oldSpan = before.slice(prefix, before.length - suffix)
    const newSpan = rendered.slice(prefix, rendered.length - suffix)
    const start = anchorSpan(source, before, prefix, suffix, oldSpan)
    if (start < 0) return null
    const exact =
      source.slice(0, start) + newSpan + source.slice(start + oldSpan.length)
    return provesExact(exact, rendered) ? exact : null
  }
  // The current pair's exact bytes while its rendering holds; a mismatch revokes the pair.
  const currentPairExact = (rendered: string): string | null => {
    if (exactTransactionMarkdown === null) return null
    reanchorAfterModeSwitch(rendered)
    if (
      exactTransactionRendered === null &&
      (!editBeforeAnchor ||
        rendered === exactTransactionMarkdown ||
        renderedFromExact(exactTransactionMarkdown, rendered))
    ) {
      exactTransactionRendered = rendered
      anchorMode = window.vditor.getCurrentMode?.() ?? null
    }
    if (rendered === exactTransactionRendered) return exactTransactionMarkdown
    exactTransactionMarkdown = null
    exactTransactionRendered = null
    // A rendering that changed outside an action's own apply window (an untrusted editor edit, a
    // streamed or host-updated rebuild) no longer derives from the owned base; keeping it would let
    // a caller that plans on the rendering pass the host guard. Inside the window the change is the
    // action's own setValue.
    if (!actionApplying) ownedBase = null
    advanceSourceRevision()
    return null
  }
  // A remembered pair whose rendering is back (an edit and its Undo) owns the document again, but
  // only while the host still holds its bytes: after a plain post the host text is unknown.
  const recallRemembered = (rendered: string): string | null => {
    if (
      !remembered ||
      remembered.exact !== hostBase ||
      rememberedRendering() !== rendered
    )
      return null
    const exact = remembered.exact
    remembered = null
    lastRebase = null
    exactTransactionMarkdown = exact
    exactTransactionRendered = rendered
    anchorMode = window.vditor.getCurrentMode?.() ?? null
    editBeforeAnchor = false
    advanceSourceRevision()
    return exact
  }
  const snapshotPair = (): { exact: string | null; rendered: string } => {
    const rendered = snapshotMarkdown()
    const owned = currentPairExact(rendered) ?? recallRemembered(rendered)
    if (owned !== null) {
      ownedBase = owned
      return { exact: owned, rendered }
    }
    const rebased = rebaseUnpublished(rendered)
    if (rebased !== null) ownedBase = hostBase
    else if (!actionApplying) ownedBase = null
    return { exact: rebased, rendered }
  }
  const snapshotExactMarkdown = (): string | null => snapshotPair().exact
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
    seedStartRequested = true
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
    deferredSeedOpen = false
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

  // Task 607: the host minimizes a plain edit against its own bytes, so after one this webview no
  // longer knows what the host holds, and a refused exact edit can no longer be rolled back.
  const notePlainPost = (content: string): void => {
    hostBase = null
    hostReference = content
    ownedBase = null
    remembered = null
    lastRebase = null
    if (latestExact) latestExact.plainAfter = true
    // The edit is posted first, so the host answers with the text that includes it.
    releaseBackgroundWaiters()
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
    notePlainPost(content)
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
  // Waiting background acquires ask once the pending edit resolves, whether or not it posted
  // (a suppressed idle, an exact seed's own rebuild, a mode switch).
  // Newer typing scheduled meanwhile keeps them waiting for its own publish.
  const releaseBackgroundWaiters = (): void => {
    if (backgroundWaiters.length && !pendingEdit.pending)
      settleBackgroundWaiters(requestExactAuthority())
  }
  const pendingEdit = createPendingEdit({
    wait: 250,
    onIdle: async () => {
      try {
        await postIdleEdit()
      } finally {
        releaseBackgroundWaiters()
      }
    },
    onFlush: () => {
      try {
        flushEdit(false, takeRendererPerf('flush'))
      } finally {
        releaseBackgroundWaiters()
      }
    },
  })
  async function postIdleEdit(): Promise<void> {
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
  }

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
      notePlainPost(content)
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
      notePlainPost(content)
      if (perf)
        vscode.postMessage({
          command: 'edit-perf-renderer',
          id: perf.id,
          postMessageMs: performance.now() - postStarted,
          state: 'posted',
        })
    }
    userInputPending = false
    // Task 602: a flush cancels the idle timer, so postEdit()'s syncUndoDelay() never ran for
    // typing that the undo-keybind entry wrapper, Undo/Redo, a block action, a rewrap or a save
    // flushed first. A large WYSIWYG document then kept the 800 ms default instead of 2 s.
    // Every route that posts user input re-evaluates the mode-aware window here, as postEdit does.
    syncUndoDelay()
  }

  // Flush pending typing, unless an exact transaction the host already holds still owns the
  // rendered document and nothing was typed since: then there is nothing newer to post.
  const settleExactInput = (): void => {
    if (!userInputPending && exactTransactionMarkdown !== null) {
      const exact = snapshotExactMarkdown()
      if (
        exactTransactionMarkdown === exact &&
        exactTransactionRendered !== null &&
        exact !== exactTransactionRendered
      ) {
        pendingEdit.cancel()
        cancelRendererPerf()
        return
      }
    }
    pendingEdit.flush()
  }

  // Task 607 rule 4: pull-based recovery. One request is in flight at a time; the reply is adopted
  // only while the rendering it was requested for is still live, nothing was typed since, and that
  // rendering is the projection of the host's bytes.
  const acquireExactAuthority = (
    opts: { publish?: boolean; background?: boolean } = {},
  ): Promise<{ exact: string; rendered: string } | null> => {
    if (!opts.publish) {
      const pair = snapshotPair()
      if (pair.exact !== null)
        return Promise.resolve({ exact: pair.exact, rendered: pair.rendered })
    }
    if (authorityRequest) return authorityRequest.promise
    if (opts.background) {
      if (!pendingEdit.pending) return requestExactAuthority()
      return new Promise((resolve) => {
        const waiter = {
          resolve,
          timer: setTimeout(() => {
            backgroundWaiters = backgroundWaiters.filter(
              (entry) => entry !== waiter,
            )
            resolve(null)
          }, EXACT_AUTHORITY_TIMEOUT_MS),
        }
        backgroundWaiters.push(waiter)
      })
    }
    settleExactInput()
    return requestExactAuthority()
  }
  const requestExactAuthority = (): Promise<{
    exact: string
    rendered: string
  } | null> => {
    if (authorityRequest) return authorityRequest.promise
    if (isSuppressed()) return Promise.resolve(null)
    const requestId = newRequestId()
    const rendered = snapshotMarkdown()
    let resolve!: (value: { exact: string; rendered: string } | null) => void
    const promise = new Promise<{ exact: string; rendered: string } | null>(
      (done) => {
        resolve = done
      },
    )
    const request = {
      requestId,
      rendered,
      trustedInputs,
      promise,
      resolve,
      timer: setTimeout(() => {
        if (authorityRequest !== request) return
        authorityRequest = null
        resolve(null)
      }, EXACT_AUTHORITY_TIMEOUT_MS),
    }
    authorityRequest = request
    vscode.postMessage({ command: 'request-exact-authority', requestId })
    return promise
  }
  // An exact post or a rollback replaces the document an in-flight request was asked for.
  const releaseAuthorityRequest = (): void => {
    const request = authorityRequest
    if (!request) return
    authorityRequest = null
    clearTimeout(request.timer)
    request.resolve(null)
  }
  const receiveExactAuthority = (message: {
    requestId: string
    content: string
  }): void => {
    const request = authorityRequest
    if (!request || request.requestId !== message.requestId) return
    authorityRequest = null
    clearTimeout(request.timer)
    const rendered = snapshotMarkdown()
    if (
      rendered !== request.rendered ||
      trustedInputs !== request.trustedInputs ||
      !provesExact(message.content, rendered)
    ) {
      request.resolve(null)
      return
    }
    exactTransactionMarkdown = message.content
    exactTransactionRendered = rendered
    anchorMode = window.vditor.getCurrentMode?.() ?? null
    editBeforeAnchor = false
    remembered = null
    lastRebase = null
    hostBase = message.content
    hostReference = hostBase
    ownedBase = message.content
    advanceSourceRevision()
    request.resolve({ exact: message.content, rendered })
  }
  // Task 607 rule 8 (D2): undo a refused action as Move Block does, unless typing was published
  // after it (the DOM then holds that typing) or the caller kept its DOM (a history replay).
  const receiveExactRefusal = (message: {
    requestId?: string
    content: string
  }): void => {
    const latest = latestExact
    if (!latest || message.requestId !== latest.requestId) return
    latestExact = null
    remembered = null
    lastRebase = null
    ownedBase = null
    if (latest.plainAfter || latest.rollback === false) {
      exactTransactionMarkdown = null
      exactTransactionRendered = null
      hostBase = null
      hostReference = hostBase
      advanceSourceRevision()
      return
    }
    pendingEdit.cancel()
    cancelRendererPerf()
    userInputPending = false
    releaseAuthorityRequest()
    settleBackgroundWaiters(null)
    deps.setApplying?.(true)
    try {
      window.vditor.setValue(message.content)
      latest.rollback?.restore()
    } finally {
      deps.setApplying?.(false)
    }
    exactTransactionMarkdown = message.content
    exactTransactionRendered = null
    editBeforeAnchor = false
    hostBase = message.content
    hostReference = hostBase
    advanceSourceRevision()
    replaceIncrementalSeed(seedFromExactMarkdown(message.content))
  }

  const receiveDeferredSeed = (
    seed: IncrementalSeedPayload,
    content: string,
  ): void => {
    const applies =
      deferredSeedOpen &&
      !hostSeed &&
      !userInputPending &&
      !pendingEdit.pending &&
      hostBase !== null &&
      hostBase === content
    deferredSeedOpen = false
    if (!applies) return
    // The same state an `init` carrying this seed would have built: the DOM is still the host's
    // rendering of `content`, so its own settling input stays unposted until the seed completes.
    hostSeed = seed
    exactSeedOwned = true
    measuredAdmission = undefined
    lastSerializeMode = null
    incrementalIr.invalidate()
    if (seedStats) {
      seedStats.sourceReason = seed.reason
      seedStats.hostMs = seed.hostMs
    }
    if (seedStartRequested) startIncrementalSeed()
  }

  return {
    schedule: () => {
      deferredSeedOpen = false
      if (exactTransactionRendered === null) editBeforeAnchor = true
      scheduleRendererPerf()
      pendingEdit.schedule()
    },
    markUserInput: (isTrusted = true) => {
      deferredSeedOpen = false
      if (exactTransactionRendered === null) editBeforeAnchor = true
      // Programmatic setValue emits an untrusted input while its known exact seed is settling.
      // A trusted keyboard/paste edit always revokes that ownership; other synthetic editor
      // actions still count as input when no exact transaction owns the rebuild.
      if (isTrusted) {
        userInputPending = true
        exactSeedOwned = false
        // Task 607: keep the revoked pair, so a rendering that proves it again (Undo) or a
        // one-span rebase of unpublished typing can still name exact bytes.
        if (exactTransactionMarkdown !== null)
          remembered = {
            exact: exactTransactionMarkdown,
            rendered: exactTransactionRendered,
          }
        exactTransactionMarkdown = null
        exactTransactionRendered = null
        ownedBase = null
        lastRebase = null
        trustedInputs++
        advanceSourceRevision()
      }
    },
    markEditorChange: () => {
      deferredSeedOpen = false
      if (exactTransactionRendered === null) editBeforeAnchor = true
    },
    // Task 196: every save flushes too (save-flush.ts, on the host's will-save). Posting
    // Vditor's rendered serialization there replaced exact bytes the host already holds (after
    // Find, a block action or a rewrap) with normalized ones on every save; the same
    // exact-ownership check as a block action's settle keeps them.
    flush: () => settleExactInput(),
    // Task 601: the host must hold the edit before the history transition that undoes it; both
    // messages share the host's edit chain, so posting the edit first orders them. Unlike `flush`,
    // nothing scheduled means nothing to post: a settled Undo publishes only its transition.
    flushHistoryInput: () => {
      if (!pendingEdit.pending || isSuppressed()) return false
      settleExactInput()
      return true
    },
    equivalentToHost: (rendered) => {
      const source = hostReference
      if (source === null) return false
      return renderedStatesEquivalent(
        (markdown) => {
          // The reference's projection is reused until the reference changes.
          if (markdown === source) {
            const mode = window.vditor.getCurrentMode?.() ?? null
            if (
              projectedReference?.source !== source ||
              projectedReference.mode !== mode
            )
              projectedReference = {
                source,
                mode,
                projected: projectLikeHost(source),
              }
            return projectedReference.projected
          }
          return projectLikeHost(markdown)
        },
        source,
        rendered,
      )
    },
    historyText: () =>
      window.vditor.getCurrentMode?.() === 'sv'
        ? serializeSvForHost()
        : vditor.getValue(),
    settleBlockActionInput: () => settleExactInput(),
    snapshotMarkdown,
    snapshotExactMarkdown,
    snapshotPair,
    snapshotRevision: () => sourceRevision,
    prepareRewrap: () => {
      pendingEdit.cancel()
      if (userInputPending) flushEdit(true, takeRendererPerf('flush'))
      else vscode.postMessage({ command: 'request-rewrap-document' })
    },
    setActionApplying: (applying) => {
      // Task 607: with no owned base the action's post will carry no `before` and may be refused;
      // publish pending typing now, while the DOM still shows it without the action, so the host
      // text a refusal rolls back to keeps it. With an owned base (D3) the typing rides along in
      // the exact post instead. `postExact` runs after the action's setValue, too late for this.
      if (applying && ownedBase === null && pendingEdit.pending)
        pendingEdit.flush()
      actionApplying = applying
    },
    postExact: (content, opts) => {
      // Task 607 rule 7: the host writes the edit only while it still holds `before`. Pending
      // typing is cancelled, not flushed, so a rebased action (D3) posts its typing with it.
      const before = opts?.before ?? ownedBase
      releaseAuthorityRequest()
      pendingEdit.cancel()
      cancelRendererPerf()
      // The exact transaction supersedes the triggering input. Clear this before starting the
      // seed so delayed setValue mutations are recognized as the same exact rebuild, not a new edit.
      userInputPending = false
      exactTransactionMarkdown = content
      exactTransactionRendered = null
      editBeforeAnchor = false
      remembered = null
      lastRebase = null
      // The cancelled typing never publishes; this post owns the document instead.
      settleBackgroundWaiters(null)
      advanceSourceRevision()
      replaceIncrementalSeed(seedFromExactMarkdown(content))
      if (isSuppressed()) return
      hostBase = content
      hostReference = hostBase
      const requestId = newRequestId()
      latestExact = { requestId, rollback: opts?.rollback, plainAfter: false }
      vscode.postMessage({
        command: 'edit',
        content,
        exact: true,
        ...(before === null ? {} : { before }),
        requestId,
      })
      syncUndoDelay()
    },
    acquireExactAuthority,
    receiveExactAuthority,
    receiveExactRefusal,
    invalidate: () => {
      deferredSeedOpen = false
      advanceSourceRevision()
      cancelRendererPerf()
      cancelSeed()
      exactSeedOwned = false
      incrementalIr.invalidate()
      ;(window as any).__vmdeInvalidatePreview?.('content')
    },
    reseed: (seed, exactMarkdown) => {
      advanceSourceRevision()
      exactTransactionMarkdown = exactMarkdown ?? seed?.markdown ?? null
      exactTransactionRendered = null
      editBeforeAnchor = false
      // Host-originated bytes: the host holds them, and an earlier pair no longer applies.
      hostBase = exactTransactionMarkdown
      hostReference = hostBase
      remembered = null
      lastRebase = null
      replaceIncrementalSeed(seed)
    },
    reportDocMode,
    startIncrementalSeed,
    receiveDeferredSeed,
    dispose: () => {
      deferredSeedOpen = false
      advanceSourceRevision()
      pendingEdit.cancel()
      cancelRendererPerf()
      cancelSeed()
      exactSeedOwned = false
      exactTransactionMarkdown = null
      exactTransactionRendered = null
      remembered = null
      hostBase = null
      hostReference = hostBase
      ownedBase = null
      latestExact = null
      settleBackgroundWaiters(null)
      if (authorityRequest) {
        clearTimeout(authorityRequest.timer)
        authorityRequest.resolve(null)
        authorityRequest = null
      }
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
