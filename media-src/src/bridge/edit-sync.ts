import { createIncrementalMd } from './incremental-md'
import { createPendingEdit, type PendingIdleReason } from './pending-edit'
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
import { isOwnHintRecord, stripWrapHints } from '../util/wrap-hint-mark'
import { takeExplicitEdit } from '../links/link-url'
import { registerQuietObserver } from '../util/mutation-impact'
import { trackedEditorRange } from '../editing/editor-caret'
import { svSourceDerivesFrom } from './sv-source-relation'
import type { ModelSession } from './model-session'
import { singleSpanDiff } from './change-set'
import {
  createDeltaSync,
  type DeltaFallbackReason,
  type DeltaSync,
} from './delta-sync'

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
  /** Task 733 (007-B): the delta publisher of this instance, or null when no text model serves it. */
  readonly deltaSync: DeltaSync | null
  /** Schedule a debounced edit→host post (called from Vditor's input()). */
  schedule(): void
  /** Resume an ordinary typing post held for an automatic exact-source attempt. */
  resumeDeferredInput(): void
  /** Mark that the pending schedule came from a real DOM input. */
  markUserInput(isTrusted?: boolean): void
  /** Flush the pending edit synchronously (the host's will-save `flush-for-save`). */
  flush(): void
  /** Task 601: before an Undo/Redo transition, post a still-scheduled edit now, with the same
   * exact-source rules as `flush`. Posts nothing when no edit is scheduled. Returns whether one was.
   * Task 677: `recordedEntry` marks Vditor's own delayed undo entry (not an Undo/Redo or Save); while
   * an automatic attempt is pending and has proven nothing yet, that flush keeps the typing deferred. */
  flushHistoryInput(options?: { recordedEntry?: boolean }): boolean | 'deferred'
  /** Task 628 (R2): whether `rendered` (the live document as `edit` posts carry it) renders like
   * the text the host holds, so an undo boundary has nothing to publish. The host's own semantic
   * no-op test: both texts through Lute's IR round trip, equal up to trailing newlines. False when the host text is unknown, the document is large, or Lute is missing. */
  equivalentToHost(rendered: string): boolean
  /** Task 602: the live document in the text form `edit` posts use (SV without Vditor's trailing
   * editable newline, otherwise `getValue()`), so history messages compare with published edits.
   * Task 720 (D2): a large IR document reads it from the incremental cache, byte-identical to
   * `getValue()`, once that cache is baselined. */
  historyText(): string
  /** Task 700: the canonical Markdown of a saved history snapshot (`html` as Vditor stored it for
   * `mode`), in the form `historyText` returns for the same state; `undefined` for an unknown
   * mode, a missing serializer, or a failure. Reads only `html`: it never touches the live editor,
   * its selection or the incremental caches, and posts nothing. */
  historySnapshotText(mode: string, html: string): string | undefined
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
  /** Task 700 (D14): `true` when the clean rendered memo alone proves an owned exact source; `false`
   * when unknown (no clean memo) or not owned. Never serializes; fall back to `snapshotPair()`. */
  ownsExact(): boolean
  /** Task 607: resolve an owned pair at once, or settle typing and pull the host's bytes, adopting
   * them only with a rendering proof. `null` after 1.5 s or without proof: the caller declines.
   * `background` (display consumers) never flushes typing: pending typing first publishes on its
   * own debounce, so a display read cannot split one host Undo step into two. */
  acquireExactAuthority(opts?: {
    publish?: boolean
    background?: boolean
    /** Task 733 / 010: the caller reads `rendered` only off the model route; it is read on first use. */
    lazyRendering?: boolean
  }): Promise<{ exact: string; rendered: string } | null>
  /** Task 607: an exact action's own apply window (its setValue before `postExact`). Only here
   * does a rendering change keep the owned base; streaming and host updates are not this window.
   * Entering it with typing pending and no owned base publishes that typing as a plain edit first,
   * so a refused action rolls back to host text that still holds it. */
  setActionApplying(applying: boolean): void
  /** Host reply to `request-exact-authority`; stale request ids are ignored. */
  receiveExactAuthority(message: {
    requestId: string
    content: string
    // Task 712: the host's echo of the last plain edit it processed.
    editSequence?: number
  }): void
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
  /** Task 733 / 010 (shared rules 3.7): while the model owns the text, apply `after` by units and post
   * the change as one `edit-delta`. 'fallback': nothing was changed; the caller runs its setValue and
   * `postExact`. 'applied': the DOM holds `after` and the host was told (a delta, or the whole text). */
  applyExactText(after: string, opts?: PostExactOptions): 'applied' | 'fallback'
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
  /** Task 685: this post replays the Undo or Redo of an exact action, so the host may reach the
   *  same bytes through VS Code's native history first (and fall back to writing them). */
  history?: 'undo' | 'redo'
}

const EXACT_AUTHORITY_TIMEOUT_MS = 1500

const normalizeEol = (text: string): string => text.replace(/\r\n?/g, '\n')

interface EditSyncDeps {
  /** IR auto-wrap must attempt its exact plan before an ordinary typing post retires the pair. */
  deferTypingPost?: () => boolean
  /** True while an extension-update / streaming is in flight — suppress posts (a
   *  partial getValue() would save a truncated document). Read at call time. */
  isSuppressed: () => boolean
  /** Task 646: revision of the last host update this webview applied; plain edits carry it. */
  hostRevision?: () => number | undefined
  /** Task 624: clock for the debounce's overdue check (test seam); defaults to `performance.now`. */
  now?: () => number
  /** Enter or leave the applying state while a refused exact edit is rolled back. */
  setApplying?: (value: boolean) => void
  /** Doc-mode flags fixed for the document's lifetime, for the status-bar marker:
   *  content-visibility (≥100 KB) and streaming (>700 KB) are fixed; incremental
   *  serialization (≥700 blocks) can flip as the user edits (recomputed per report). */
  docMode: { cvActive: boolean; streamActive: boolean; docChars: number }
  incrementalSeed?: IncrementalSeedPayload
  /** Host bytes used to build this editor instance. */
  initialMarkdown?: string
  /** Task 733: the text model shadowing whole-text publications; absent in tests that do not need it. */
  modelSession?: Pick<
    ModelSession,
    'beforeWholeTextPost' | 'onModeChange' | 'turnOff'
  > &
    Partial<
      Pick<
        ModelSession,
        | 'deltaPort'
        | 'canPublishDelta'
        | 'ownsText'
        | 'onWholeTextPublished'
        | 'recordFallback'
        | 'markExplicitAtCaret'
        | 'applyText'
        | 'rebuildAfterExact'
      >
    >
  /** An IME composition is running (the delta publisher publishes nothing then, except for a flush). */
  isComposing?: () => boolean
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
  snapshotMemoHits: number
  fullFallbacks: number
  longTasks: number
  maxLongTaskMs: number
}

type IncrementalSeedWindow = Window & {
  __vmdeE2EReadiness?: unknown
  __vmdeIncrementalSeedStats?: IncrementalSeedE2EStats
  __vmdeE2ESnapshotMarkdown?: () => string
  __vmdeE2EExactMarkdown?: () => string | null
  __vmdeE2EHistoryText?: () => string
  /** Task 720 (D2): set to an array by a spec to audit every `historyText` read against a full
   * `getValue()`; never set in production. */
  __vmdeE2EHistoryAudit?: HistoryTextAudit[]
}

/** One audited `historyText` read (E2E only): which path served it and whether it matched a full
 * `getValue()` of the same DOM. */
interface HistoryTextAudit {
  path: 'incremental' | 'full'
  equal: boolean
  length: number
  fullLength: number
  firstDiff: number
  fast: string
  full: string
}

// Index of the first differing character, or -1 when the strings are equal.
const firstDifference = (a: string, b: string): number => {
  if (a === b) return -1
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return n
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
    snapshotMemoHits: 0,
    fullFallbacks: 0,
    longTasks: 0,
    maxLongTaskMs: 0,
  }
  return win.__vmdeIncrementalSeedStats
}

function seedMutationAffectsSource(record: MutationRecord): boolean {
  // Task 640: a wrap hint is view state, so the hint engine's own writes never cancel the seed.
  if (isOwnHintRecord(record)) return false
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
  let deferredPlainPost = false
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
  // Task 712 (Q2 A): every plain post carries a number; the host's exact-authority reply echoes the
  // number of the plain edit it processed last. `lastPlainPost` is this webview's last plain post.
  let plainSequence = 0
  let lastPlainPost: { sequence: number; content: string } | null = null
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
    // Task 640: wrap hints are view state; the cache compares and serializes blocks without them.
    irBlocks(el).map((block) => stripWrapHints(block.outerHTML))
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
  // Task 655: lets a decorator's own DOM writes bypass the seed observer (util/mutation-impact.ts).
  let unregisterQuietSeed: () => void = () => undefined
  let activeSeed: ReturnType<typeof incrementalIr.beginSeed> | undefined

  const cancelSeed = (state: 'cancelled' | 'idle' = 'cancelled') => {
    if (seedFrame) cancelAnimationFrame(seedFrame)
    seedFrame = 0
    seedObserver?.disconnect()
    seedObserver = undefined
    unregisterQuietSeed()
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
  // Task 720 (D2): the history coupling (undo-keybind.ts) reads the document before and after every
  // Undo/Redo. A whole-document `getValue()` costs 0.5 to 0.9 s per read on a 112 KB IR document.
  // The incremental cache serializes only the blocks that changed since its last read (the
  // block-scoped restore keeps the others as the same nodes), and its result is byte-identical to
  // `getValue()` (task-69 contract; the save audit in `flushEdit` checks it). It also is the form
  // `edit` posts carry, which the host's history coupling compares with. Served only while the cache
  // is already IR-baselined and no seed is pending: a cold cache would cost a full serialize anyway,
  // and this read must not move `lastSerializeMode`, which postEdit's mode-switch test reads.
  const incrementalHistoryText = (): string | undefined => {
    if (lastSerializeMode !== 'ir-incremental' || seedState === 'pending')
      return undefined
    const el = irIncrementalElement()
    return el ? incrementalIr.update(irTopBlocks(el)) : undefined
  }
  // E2E only (`__vmdeE2EHistoryAudit` set by a spec): compare a history read with a full
  // `getValue()` of the same DOM, keeping only a window around the first difference.
  const auditHistoryRead = (text: string, fast: string | undefined): void => {
    const audit = seedStats
      ? (window as IncrementalSeedWindow).__vmdeE2EHistoryAudit
      : undefined
    if (!Array.isArray(audit)) return
    const full = fast === undefined ? text : vditor.getValue()
    const firstDiff = firstDifference(text, full)
    const around = (value: string) =>
      firstDiff < 0
        ? ''
        : value.slice(Math.max(0, firstDiff - 40), firstDiff + 40)
    audit.push({
      path: fast === undefined ? 'full' : 'incremental',
      equal: firstDiff < 0,
      length: text.length,
      fullLength: full.length,
      firstDiff,
      fast: around(text),
      full: around(full),
    })
  }
  const historyText = (): string => {
    if (window.vditor.getCurrentMode?.() === 'sv') return serializeSvForHost()
    const fast = incrementalHistoryText()
    const text = fast ?? vditor.getValue()
    auditHistoryRead(text, fast)
    return text
  }
  // Task 700 (d): memo of the last rendered serialization. Vditor's `getMarkdown` reads only the
  // current mode, that mode's element and `lute`, so the string stays exact until the element
  // mutates, the mode/element/Lute changes, or a caller clears it. The 607 chain (snapshotPair,
  // acquire, request, reply, retry) otherwise re-serializes the same unchanged DOM 5 times. Only
  // `snapshotMarkdown` uses it; post paths and other `serializeForHost` callers stay uncached.
  // Lute option setters that touch `*DOM2Md` at runtime: `preview-render.ts` SetSoftBreak2HardBreak
  // (set and restored synchronously, so no snapshot sees it) and `custom-renderer.ts`
  // SetJSRenderers (init only; the Lute-identity key covers a rebuilt instance).
  let renderedMemo: {
    element: Node
    mode: string | null
    lute: unknown
    rendered: string
    observer: MutationObserver
    dirty: boolean
  } | null = null
  const clearRenderedMemo = (): void => {
    renderedMemo?.observer.disconnect()
    renderedMemo = null
  }
  // The memoized rendering while it still holds for the live element, mode and Lute; else null.
  // Reads no Markdown, so a caller may probe it without a serialization.
  const cleanRenderedMemo = (): string | null => {
    const el = activeModeElement(window.vditor) as unknown
    const memo = renderedMemo
    if (
      !memo ||
      memo.element !== el ||
      memo.mode !== (window.vditor.getCurrentMode?.() ?? null) ||
      memo.lute !== innerVditor()?.lute ||
      memo.dirty ||
      memo.observer.takeRecords().length !== 0
    )
      return null
    return memo.rendered
  }
  const snapshotMarkdown = (): string => {
    const el = activeModeElement(window.vditor) as unknown
    const memoable =
      el instanceof Node &&
      el.isConnected &&
      typeof MutationObserver !== 'undefined'
    // Task 700 (D14): `snapshotCalls` counts serializations (the cost Task 537's limit guards), so
    // a memo hit counts in `snapshotMemoHits` instead.
    if (!memoable) {
      if (seedStats) seedStats.snapshotCalls++
      clearRenderedMemo()
      return serializeForHost()
    }
    const mode = window.vditor.getCurrentMode?.() ?? null
    const lute = innerVditor()?.lute
    const hit = cleanRenderedMemo()
    if (hit !== null) {
      if (seedStats) seedStats.snapshotMemoHits++
      return hit
    }
    if (seedStats) seedStats.snapshotCalls++
    clearRenderedMemo()
    const rendered = serializeForHost()
    const next = {
      element: el,
      mode,
      lute,
      rendered,
      dirty: false,
      observer: new MutationObserver(() => {
        next.dirty = true
        next.observer.disconnect()
      }),
    }
    next.observer.observe(el, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
    renderedMemo = next
    return rendered
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
  // Task 675: the host-request relation of Source mode. The Source text may carry what Lute or
  // Vditor changed (table padding, sequential list numbers, one more trailing line break), so a host
  // reply is also accepted when it derives that text. Only the reply check uses it: the rebase of
  // unpublished typing (`rebaseOneSpan`) keeps `provesExact`.
  const hostDerivesSourceText = (exact: string, rendered: string): boolean =>
    window.vditor.getCurrentMode?.() === 'sv' &&
    svSourceDerivesFrom(exact, rendered)
  // Task 712 (Q2 A): after a switch from IR or WYSIWYG the Source text is Lute's serialization,
  // which may drop blank lines, join soft breaks or change inline HTML, so no line relation can
  // accept it. The host's text still answers it when the Source text is exactly this webview's last
  // plain post, the host echoes that post's number (it processed it last, so nothing stale or
  // refused), and the webview knows of nothing the host received since. One string comparison.
  const hostAnsweredSourcePost = (
    editSequence: number | undefined,
    rendered: string,
  ): boolean =>
    window.vditor.getCurrentMode?.() === 'sv' &&
    lastPlainPost !== null &&
    editSequence === lastPlainPost.sequence &&
    hostReference === lastPlainPost.content &&
    rendered === lastPlainPost.content
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
    const modelExact = liveExactText()
    if (modelExact !== null)
      return { exact: modelExact, rendered: snapshotMarkdown() }
    return snapshotPairFor(snapshotMarkdown())
  }
  const snapshotPairFor = (
    rendered: string,
  ): { exact: string | null; rendered: string } => {
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
  // Task 700 (D14): whether an owned exact source describes the live rendering, decided from the
  // clean rendered memo alone. `false` also means "not provable without a serialization", so the
  // caller falls back to `snapshotPair()`; it never reads Markdown itself.
  const ownsExact = (): boolean => {
    if (liveSession?.ownsText?.() && !composing()) return true
    const rendered = cleanRenderedMemo()
    return rendered !== null && snapshotPairFor(rendered).exact !== null
  }
  const snapshotExactMarkdown = (): string | null =>
    liveExactText() ?? snapshotPair().exact
  if (seedStats) {
    ;(window as IncrementalSeedWindow).__vmdeE2ESnapshotMarkdown =
      snapshotMarkdown
    ;(window as IncrementalSeedWindow).__vmdeE2EExactMarkdown =
      snapshotExactMarkdown
    ;(window as IncrementalSeedWindow).__vmdeE2EHistoryText = historyText
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
    const onSeedRecords = (records: MutationRecord[]): void => {
      if (!records.some(seedMutationAffectsSource)) return
      // Vditor can finish a setValue/exact-format rebuild in later microtasks. Those mutations
      // still describe the host seed and may restart after quiet; a trusted user input revokes
      // exactSeedOwned before the observer callback and must cancel the now-stale seed.
      const retryExactRebuild = exactSeedOwned && hostSeed !== undefined
      cancelSeed()
      if (retryExactRebuild) retryExactSeedAfterPaint()
    }
    seedObserver = new MutationObserver(onSeedRecords)
    unregisterQuietSeed = registerQuietObserver(seedObserver, onSeedRecords)
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
        seedBlocks.push(stripWrapHints(blockElements[captureIndex].outerHTML))
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
      unregisterQuietSeed()
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
    clearRenderedMemo()
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

  // Task 699: the one reader of the explicit-edit flag. Every route that posts an `edit` calls it
  // (postEdit and both flushEdit branches), so the boundary's immediate flush cannot leave the flag
  // unread and post the link without its block. One window-property read; the block lookup runs only
  // while the flag is set.
  const takeExplicitBlock = (): string | undefined =>
    takeExplicitEdit(window) ? explicitBlockMd() : undefined

  const preserveAutomaticInput = (rendered: string): string => {
    if (
      !(deferredPlainPost || deps.deferTypingPost?.()) ||
      !remembered ||
      !/^---[ \t]*(?:\r\n|\n|\r|$)/u.test(remembered.exact)
    )
      return rendered
    // Save/Undo bypass the automatic timer. Preserve the same provable one-span typing source,
    // including YAML's source-only separator, without treating a rendering as exact authority.
    return rebaseUnpublished(rendered) ?? rendered
  }

  // Task 607: the host minimizes a plain edit against its own bytes, so after one this webview no
  // longer knows what the host holds, and a refused exact edit can no longer be rolled back.
  // Task 733: the text model only shadows a publication. Whatever it does, the post goes out: a
  // throwing session turns itself off and the message is sent as it was before the model existed.
  const shadowCall = <T>(call: () => T): T | undefined => {
    try {
      return call()
    } catch {
      try {
        deps.modelSession?.turnOff('sync-error')
      } catch {
        // The session is unusable; nothing else to do.
      }
      return undefined
    }
  }
  const shadowPost = (
    sequence: number,
    options?: { predict: boolean; requestId?: string },
  ): { rebind: true } | undefined =>
    shadowCall(() => deps.modelSession?.beforeWholeTextPost(sequence, options))

  const notePlainPost = (content: string, sequence: number): void => {
    lastPlainPost = { sequence, content }
    deferredPlainPost = false
    hostBase = null
    hostReference = content
    ownedBase = null
    remembered = null
    lastRebase = null
    if (latestExact) latestExact.plainAfter = true
    // The edit is posted first, so the host answers with the text that includes it.
    releaseBackgroundWaiters()
  }

  // Task 733 (007-B): while the text model is live in IR, a publication is an `edit-delta` from the
  // model (delta-sync.ts). Whatever it cannot publish goes through `publishWhole`, which is the
  // ordinary whole-text post with `rebind: true`; with the model off every site below keeps its code.
  const liveSession = deps.modelSession
  const deltaPort = liveSession?.deltaPort?.()
  let fallbackIsFlush = false
  let fallbackRewrap = false
  let fallbackExplicit: string | undefined
  const publishWhole = (
    _reason: DeltaFallbackReason,
    perf?: RendererEditPerf,
  ): void => {
    const content = preserveAutomaticInput(serializeForHost())
    if (perf) perf.payloadBytes = new TextEncoder().encode(content).length
    const postStarted = performance.now()
    const sequence = ++plainSequence
    shadowCall(() => liveSession?.onWholeTextPublished?.(sequence))
    vscode.postMessage({
      command: 'edit',
      content,
      revision: deps.hostRevision?.(),
      sequence,
      ...(fallbackIsFlush ? { rewrapDocument: fallbackRewrap } : {}),
      explicitBlock: fallbackExplicit,
      ...(perf ? { perf } : {}),
      rebind: true,
    })
    notePlainPost(content, sequence)
    if (perf)
      vscode.postMessage({
        command: 'edit-perf-renderer',
        id: perf.id,
        postMessageMs: performance.now() - postStarted,
        state: 'posted',
      })
  }
  const deltaSync: DeltaSync | null =
    liveSession && deltaPort
      ? createDeltaSync({
          session: deltaPort,
          postMessage: (message) => {
            if (message.command === 'edit-delta' && message.perf)
              message.perf.payloadBytes = new TextEncoder().encode(
                JSON.stringify(message),
              ).length
            vscode.postMessage(message)
          },
          publishWhole,
          countFallback: (reason) =>
            shadowCall(() => liveSession.recordFallback?.(reason)),
          isComposing: () => deps.isComposing?.() ?? false,
          now: () => performance.now(),
          requestPublication: () => pendingEdit.schedule(),
          afterDelta: () => {
            afterDeltaPost(undefined, performance.now())
            advanceSourceRevision()
          },
        })
      : null
  const composing = (): boolean => deps.isComposing?.() ?? false

  const afterDeltaPost = (
    perf: RendererEditPerf | undefined,
    started: number,
  ): void => {
    // The model text is the host text plus this delta (P2): the whole-text anchors restart from it.
    hostBase = null
    hostReference = deltaPort?.modelText() ?? hostReference
    ownedBase = null
    remembered = null
    lastRebase = null
    exactTransactionMarkdown = null
    exactTransactionRendered = null
    if (latestExact) latestExact.plainAfter = true
    if (lastSerializeMode !== 'ir-incremental') lastSerializeMode = 'ir'
    if (perf)
      vscode.postMessage({
        command: 'edit-perf-renderer',
        id: perf.id,
        postMessageMs: performance.now() - started,
        state: 'posted',
      })
    releaseBackgroundWaiters()
  }
  const afterLivePublish = (
    result: 'delta' | 'nothing' | 'fallback',
    perf: RendererEditPerf | undefined,
    started: number,
  ): void => {
    if (result === 'delta') afterDeltaPost(perf, started)
    else if (result === 'nothing') {
      cancelTakenRendererPerf(perf)
      // An answer is awaited and typing is waiting: the timer runs again.
      if (deltaPort?.awaiting() && deltaPort.hasDirty()) pendingEdit.schedule()
    }
    if (result !== 'nothing') advanceSourceRevision()
  }
  /**
   * Publishes through the delta publisher when the model serves this editor. Undefined: the model is
   * not live (or the publisher threw and turned it off), so the caller runs its existing code.
   */
  const publishLive = (
    cause: 'idle' | 'overdue' | 'flush' | 'exact',
    perf?: RendererEditPerf,
    options?: { rewrapDocument?: boolean },
  ): 'delta' | 'nothing' | 'fallback' | undefined => {
    if (!deltaSync || !liveSession?.canPublishDelta?.()) return undefined
    if (takeExplicitEdit(window)) {
      shadowCall(() => liveSession.markExplicitAtCaret?.())
      fallbackExplicit = explicitBlockMd()
    } else fallbackExplicit = undefined
    fallbackIsFlush = cause === 'flush'
    fallbackRewrap = options?.rewrapDocument ?? false
    const started = performance.now()
    const result = shadowCall(() => deltaSync.publish(cause, perf))
    if (result !== undefined) afterLivePublish(result, perf, started)
    return result
  }
  /** The model text while it owns the host bytes plus typing (published first); null otherwise. */
  const liveExactText = (): string | null => {
    if (!liveSession?.ownsText?.() || composing()) return null
    // The DOM is mid-rebuild (an action's apply window, an update, a stream): its records belong to no
    // unit yet, so the model text is returned as it is and nothing is published.
    const mid = actionApplying || isSuppressed()
    if (!mid) {
      const result = publishLive('exact')
      if (result === undefined || result === 'fallback') return null
    }
    const text = deltaPort?.modelText() ?? null
    // An action posts its exact edit against these bytes (`before`): the host holds them, behind the
    // deltas already queued (P2), and refuses the action when it does not.
    if (text !== null) ownedBase = text
    return text
  }

  /** The live branch of an idle post; false when the model does not serve this editor. */
  const postEditLive = (
    cause: 'idle' | 'overdue',
    perf?: RendererEditPerf,
  ): boolean => {
    if (publishLive(cause, perf) === undefined) return false
    userInputPending = false
    reportDocMode()
    syncUndoDelay()
    return true
  }

  const postEdit = (
    perf?: RendererEditPerf,
    cause: 'idle' | 'overdue' = 'idle',
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the live branch joins the existing mode-switch and seed early returns of one indivisible publication site.
  ) => {
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
      shadowCall(() => deps.modelSession?.onModeChange(currentMode))
      serializeForHost()
      reportDocMode()
      syncUndoDelay()
      cancelTakenRendererPerf(perf)
      return
    }
    if (postEditLive(cause, perf)) return
    const explicitBlock = takeExplicitBlock()
    const serializeStarted = performance.now()
    const content = preserveAutomaticInput(serializeForHost())
    if (perf) {
      perf.serializeMs = performance.now() - serializeStarted
      perf.payloadBytes = new TextEncoder().encode(content).length
    }
    const postStarted = performance.now()
    const sequence = ++plainSequence
    const shadow = shadowPost(sequence)
    vscode.postMessage({
      command: 'edit',
      content,
      revision: deps.hostRevision?.(),
      sequence,
      explicitBlock,
      ...(perf ? { perf } : {}),
      ...shadow,
    })
    notePlainPost(content, sequence)
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
    if (backgroundWaiters.length && !hasPendingInputPost())
      settleBackgroundWaiters(requestExactAuthority())
  }
  const pendingEdit = createPendingEdit({
    wait: 250,
    now: deps.now,
    onIdle: async (reason) => {
      // Preserve exact ownership until the automatic timer settles; Save/Undo use onFlush directly.
      if (!liveSession?.canPublishDelta?.() && deps.deferTypingPost?.()) {
        deferredPlainPost = true
        return
      }
      try {
        await postIdleEdit(reason)
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
  function hasPendingInputPost(): boolean {
    return pendingEdit.pending || deferredPlainPost
  }
  async function postIdleEdit(reason: PendingIdleReason): Promise<void> {
    const perf = takeRendererPerf('idle')
    if (isSuppressed()) {
      cancelTakenRendererPerf(perf)
      return
    }
    const postCause = reason === 'overdue' ? 'overdue' : 'idle'
    // A postEdit() throw (e.g. a Lute serialize failure) must not become an unhandled
    // rejection: pending-edit.ts's setTimeout callback fires this without awaiting it
    // (task 482, noFloatingPromises) — without this catch, an exception here would
    // silently kill this idle cycle's host sync with no trace anywhere.
    try {
      // IR is now incremental → fast even on large docs (no busy cursor). WYSIWYG/SV
      // still do a full getValue(); keep the busy-cursor + paint for that slow path.
      // Task 624: an overdue post runs inside an input callback while timers are late; a paint
      // wait could be late too (rAF pauses in hidden documents), so it posts at once.
      if (
        reason !== 'overdue' &&
        window.vditor.getCurrentMode?.() !== 'ir' &&
        isLargeDoc()
      ) {
        setBusyCursor(true)
        await nextPaint() // let the busy cursor paint before the long serialize
        try {
          postEdit(perf, postCause)
        } finally {
          setBusyCursor(false)
        }
      } else {
        postEdit(perf, postCause)
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
    // Task 733 (007-B): live, the model publishes (PD-7: the save audit does not run; the rotating audit
    // of the model starts at the `baseline`). A whole-text fallback carries `rewrapDocument` itself;
    // any other result leaves the rewrap request to be posted here.
    const live = publishLive('flush', perf, { rewrapDocument })
    if (live !== undefined) {
      if (rewrapDocument && live !== 'fallback')
        vscode.postMessage({ command: 'request-rewrap-document' })
      userInputPending = false
      syncUndoDelay()
      return
    }
    const explicitBlock = takeExplicitBlock()
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
      const content = preserveAutomaticInput(authoritative)
      if (perf) {
        perf.serializeMs = performance.now() - serializeStarted
        perf.payloadBytes = new TextEncoder().encode(content).length
      }
      const postStarted = performance.now()
      const sequence = ++plainSequence
      const shadow = shadowPost(sequence)
      vscode.postMessage({
        command: 'edit',
        content,
        revision: deps.hostRevision?.(),
        sequence,
        rewrapDocument,
        explicitBlock,
        ...(perf ? { perf } : {}),
        ...shadow,
      })
      notePlainPost(content, sequence)
      if (perf)
        vscode.postMessage({
          command: 'edit-perf-renderer',
          id: perf.id,
          postMessageMs: performance.now() - postStarted,
          state: 'posted',
        })
    } else {
      const content = preserveAutomaticInput(serializeForHost())
      if (perf) {
        perf.serializeMs = performance.now() - serializeStarted
        perf.payloadBytes = new TextEncoder().encode(content).length
      }
      const postStarted = performance.now()
      const sequence = ++plainSequence
      const shadow = shadowPost(sequence)
      vscode.postMessage({
        command: 'edit',
        content,
        revision: deps.hostRevision?.(),
        sequence,
        rewrapDocument,
        explicitBlock,
        ...(perf ? { perf } : {}),
        ...shadow,
      })
      notePlainPost(content, sequence)
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
        deferredPlainPost = false
        cancelRendererPerf()
        return
      }
    }
    pendingEdit.flush()
  }

  // Task 700 (b): see `flushHistoryInput`. True when the host already holds exactly what a
  // checkpoint flush would post.
  const checkpointHasNothingNew = (): boolean => {
    if (liveSession?.canPublishDelta?.() && !composing()) {
      const result = publishLive('flush')
      if (result !== undefined) return result === 'nothing'
    }
    const posted = lastPlainPost
    if (
      posted === null ||
      userInputPending ||
      deferredPlainPost ||
      exactTransactionMarkdown !== null ||
      authorityRequest !== null ||
      (latestExact !== null && !latestExact.plainAfter) ||
      hostReference !== posted.content ||
      irIncrementalElement() === undefined ||
      seedState === 'pending'
    )
      return false
    return serializeForHost() === posted.content
  }

  // Task 607 rule 4: pull-based recovery. One request is in flight at a time; the reply is adopted
  // only while the rendering it was requested for is still live, nothing was typed since, and that
  // rendering is the projection of the host's bytes.
  const acquireExactAuthority = (
    opts: {
      publish?: boolean
      background?: boolean
      lazyRendering?: boolean
    } = {},
  ): Promise<{ exact: string; rendered: string } | null> => {
    // Task 733 (007-B): the model holds the host bytes plus typing, so there is nothing to ask the host.
    const modelExact = liveExactText()
    if (modelExact !== null && !opts.lazyRendering)
      return Promise.resolve({
        exact: modelExact,
        rendered: snapshotMarkdown(),
      })
    if (modelExact !== null) {
      // Task 733 / 010 (DR1, DR2): every other caller pins the acquire-time rendering (a later proof
      // compares against it). The block action's model route plans on the model units and reads it
      // only when it re-derives on the existing route, so it makes no whole-document read.
      const pair = { exact: modelExact } as { exact: string; rendered: string }
      let rendered: string | undefined
      Object.defineProperty(pair, 'rendered', {
        enumerable: true,
        get: () => {
          rendered ??= snapshotMarkdown()
          return rendered
        },
      })
      return Promise.resolve(pair)
    }
    return acquireExactFromHost(opts)
  }
  const acquireExactFromHost = (opts: {
    publish?: boolean
    background?: boolean
  }): Promise<{ exact: string; rendered: string } | null> => {
    if (!opts.publish) {
      const pair = snapshotPair()
      if (pair.exact !== null)
        return Promise.resolve({ exact: pair.exact, rendered: pair.rendered })
    }
    if (authorityRequest) return authorityRequest.promise
    if (opts.background) {
      if (!hasPendingInputPost()) return requestExactAuthority()
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
    // Task 700 (D11): with nothing scheduled, a flush still posts an unchanged plain edit and
    // adds an Undo entry before the action. Settle only typing that is actually pending,
    // including a trusted keystroke whose Vditor input callback has not yet scheduled a post.
    if (hasPendingInputPost() || userInputPending) settleExactInput()
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
    editSequence?: number
  }): void => {
    const request = authorityRequest
    if (!request || request.requestId !== message.requestId) return
    authorityRequest = null
    clearTimeout(request.timer)
    const rendered = snapshotMarkdown()
    if (
      rendered !== request.rendered ||
      trustedInputs !== request.trustedInputs ||
      !(
        provesExact(message.content, rendered) ||
        hostAnsweredSourcePost(
          typeof message.editSequence === 'number'
            ? message.editSequence
            : undefined,
          rendered,
        ) ||
        hostDerivesSourceText(message.content, rendered)
      )
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
    deferredPlainPost = false
    cancelRendererPerf()
    userInputPending = false
    releaseAuthorityRequest()
    settleBackgroundWaiters(null)
    deps.setApplying?.(true)
    try {
      clearRenderedMemo()
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
      !hasPendingInputPost() &&
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
    clearRenderedMemo()
    if (seedStats) {
      seedStats.sourceReason = seed.reason
      seedStats.hostMs = seed.hostMs
    }
    if (seedStartRequested) startIncrementalSeed()
  }

  /** Today's whole-text exact post (Task 607): the host writes it only while it holds `before`. */
  const postWholeExact = (content: string, opts?: PostExactOptions): void => {
    // Task 607 rule 7: the host writes the edit only while it still holds `before`. Pending
    // typing is cancelled, not flushed, so a rebased action (D3) posts its typing with it.
    const before = opts?.before ?? ownedBase
    releaseAuthorityRequest()
    pendingEdit.cancel()
    deferredPlainPost = false
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
    // Task 733 (decision 1): the exact post changes the host bytes, so it is never predicted; it
    // takes a sequence only when the model asks the host for the bytes. The host ignores an exact
    // edit's sequence for plain ordering, and `lastPlainPost` stays the last plain post.
    const sequence = ++plainSequence
    const shadow = shadowPost(sequence, { predict: false, requestId })
    vscode.postMessage({
      command: 'edit',
      content,
      exact: true,
      ...(before === null ? {} : { before }),
      ...(opts?.history ? { history: opts.history } : {}),
      requestId,
      ...(shadow ? { sequence, ...shadow } : {}),
    })
    syncUndoDelay()
  }
  // Task 733 / 010 (shared rules 3.7): the exact post as one `edit-delta` while the model owns the
  // text. Whole-text instead for a history replay (Task 685) and while an answer is awaited.
  const ownsExactDelta = (opts?: PostExactOptions): boolean =>
    !opts?.history &&
    deltaSync !== null &&
    liveSession?.ownsText?.() === true &&
    !composing() &&
    deltaPort?.awaiting() !== true &&
    deltaPort?.modelText() !== undefined
  const rollbackOf = (opts?: PostExactOptions): ExactRollback | undefined =>
    opts?.rollback === false ? undefined : opts?.rollback
  /** The bookkeeping of an exact post that went out as a delta; the host holds `content` after it. */
  const afterExactDelta = (content: string): void => {
    releaseAuthorityRequest()
    deferredPlainPost = false
    cancelRendererPerf()
    // The delta carries the action's span only: typing outside it stays pending and publishes on its
    // own (010-R F7); with nothing left the pending publication has nothing to post.
    if (deltaPort?.hasDirty()) pendingEdit.schedule()
    else {
      pendingEdit.cancel()
      userInputPending = false
    }
    settleBackgroundWaiters(null)
    hostBase = null
    hostReference = content
    ownedBase = null
    syncUndoDelay()
  }
  const applyExactText = (
    after: string,
    opts?: PostExactOptions,
  ): 'applied' | 'fallback' => {
    if (!deltaSync || !liveSession?.applyText || !ownsExactDelta(opts))
      return 'fallback'
    const before = deltaPort?.modelText() as string
    const target = normalizeEol(after)
    const diff = singleSpanDiff(before, target)
    if (!diff) return 'applied'
    const outcome = shadowCall(() => liveSession.applyText?.([diff], 'exact'))
    if (outcome?.kind !== 'applied') return 'fallback'
    // The DOM holds `after` now; re-read the publisher's state (R-1) through its own gates.
    const posted = shadowCall(() =>
      deltaSync.publishApplied(before, [diff], rollbackOf(opts)),
    )
    if (posted?.kind === 'delta') {
      afterExactDelta(target)
      return 'applied'
    }
    // Q-79 OQ-5: the change is in the DOM but cannot go as a delta: post the whole text instead, so
    // the caller never runs its setValue a second time.
    postWholeExact(target, { ...opts, before })
    return 'applied'
  }
  const sync: EditSync = {
    deltaSync,
    resumeDeferredInput: () => {
      if (!deferredPlainPost) return
      if (userInputPending) pendingEdit.schedule()
      else {
        deferredPlainPost = false
        releaseBackgroundWaiters()
      }
    },
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
    flushHistoryInput: (options) => {
      if (!hasPendingInputPost() || isSuppressed()) return false
      // Auto-wrap proves unpublished typing before its first history checkpoint. A plain flush
      // here would revoke that base before the wrap's guarded post. Publish the already-proven
      // typing as its own exact edit, preserving the host state that one Undo must reach. Reuse
      // the cached span only while its rendering is still live; no new Lute projection is needed.
      const automatic = deps.deferTypingPost?.() ? lastRebase : null
      if (
        hostBase !== null &&
        remembered?.exact === hostBase &&
        automatic?.exact != null &&
        snapshotMarkdown() === automatic.rendered
      ) {
        sync.postExact(automatic.exact, { before: hostBase })
        // Both guarded edits use the same host queue: typing first, then the automatic action.
        ownedBase = automatic.exact
        return true
      }
      // Task 677: Vditor's delayed undo entry (800 ms in IR) can run before the auto-wrap timer. A
      // plain flush here would publish the typing as a non-exact edit and end exact ownership, so
      // the attempt's proof would find no exact source and decline. Keep the typing deferred: the
      // attempt's own entry posts it exactly, or `resumeDeferredInput` publishes it when the attempt
      // ends. Undo, Redo and Save do not pass `recordedEntry` and still publish at once.
      if (
        options?.recordedEntry &&
        !liveSession?.canPublishDelta?.() &&
        deps.deferTypingPost?.()
      ) {
        deferredPlainPost = true
        // Task 700: the caller must not pair this entry's state with the host text.
        return 'deferred'
      }
      // Task 700 (b): Vditor's delayed undo entry re-arms `pendingEdit` (via `input()`) after the
      // idle post already published these bytes. The flush below would run the Task 58 save audit
      // (a full Lute `getValue`) and post the identical content again. Skip it, for a recorded
      // entry only, when nothing newer exists: incremental IR is serving, no typing or deferred
      // post is waiting, no exact transaction owns the document, the host still holds the last
      // plain post, and the incremental serialization (a cache hit, no Lute call) equals it. The
      // caller still posts the history base. Undo, Redo and Save keep the audit; nothing becomes exact.
      if (options?.recordedEntry && checkpointHasNothingNew()) {
        // Task 699: consume the explicit-edit flag as a flush would, so a stale explicit block
        // cannot attach to a later edit.
        takeExplicitBlock()
        pendingEdit.cancel()
        cancelRendererPerf()
        releaseBackgroundWaiters()
        return true
      }
      settleExactInput()
      return true
    },
    equivalentToHost: (rendered) => {
      // Task 733 (007-B): live, the host holds exactly what the model holds once nothing is left to publish.
      if (liveSession?.ownsText?.() && !composing()) {
        const result = publishLive('idle')
        if (result !== undefined) return result === 'nothing'
      }
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
    historyText,
    historySnapshotText: (mode, html) => {
      try {
        if (mode === 'sv') {
          const container = document.createElement('div')
          container.innerHTML = html
          return serializeSvForHost(container)
        }
        const lute = innerVditor()?.lute
        // The live wrapped methods: WYSIWYG source flattening and wiki serialization are part of
        // the production contract, as for `getValue()`.
        if (mode === 'ir') return lute?.VditorIRDOM2Md?.(html)
        if (mode === 'wysiwyg') return lute?.VditorDOM2Md?.(html)
      } catch {
        return undefined
      }
      return undefined
    },
    settleBlockActionInput: () => settleExactInput(),
    snapshotMarkdown,
    snapshotExactMarkdown,
    snapshotPair,
    ownsExact,
    snapshotRevision: () => sourceRevision,
    prepareRewrap: () => {
      pendingEdit.cancel()
      deferredPlainPost = false
      if (userInputPending) flushEdit(true, takeRendererPerf('flush'))
      else vscode.postMessage({ command: 'request-rewrap-document' })
    },
    setActionApplying: (applying) => {
      // Task 607: with no owned base the action's post will carry no `before` and may be refused;
      // publish pending typing now, while the DOM still shows it without the action, so the host
      // text a refusal rolls back to keeps it. With an owned base (D3) the typing rides along in
      // the exact post instead. `postExact` runs after the action's setValue, too late for this.
      if (applying && ownedBase === null && hasPendingInputPost())
        pendingEdit.flush()
      actionApplying = applying
    },
    // Task 733 / 010 (DR1): a caller that ran its own setValue keeps today's whole-text exact post. Its
    // `before` guard refuses an edit on a host the editor never saw (Task 607/630); a delta's epoch
    // guard did not stop it there. Block actions apply by units through `applyExactText` instead.
    postExact: (content, opts) => postWholeExact(content, opts),
    applyExactText,
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
      clearRenderedMemo()
      ;(window as any).__vmdeInvalidatePreview?.('content')
    },
    reseed: (seed, exactMarkdown) => {
      deferredPlainPost = false
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
      deferredPlainPost = false
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
      clearRenderedMemo()
      longTaskObserver?.disconnect()
      longTaskObserver = undefined
      if (seedStats)
        delete (window as IncrementalSeedWindow).__vmdeE2ESnapshotMarkdown
      if (seedStats)
        delete (window as IncrementalSeedWindow).__vmdeE2EExactMarkdown
      if (seedStats)
        delete (window as IncrementalSeedWindow).__vmdeE2EHistoryText
    },
  }
  return sync
}
