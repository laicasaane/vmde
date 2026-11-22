import type {
  RendererEditPerf,
  WebviewMessage,
} from '../../../src/shared/protocol'
import {
  offsetToPosition,
  singleSpanDiff,
  type LinePosition,
  type TextChange,
  widenToCodePoints,
} from './change-set'
import type { SyncResult } from './text-model'

// Task 733 (007-A): the delta publisher. It turns the model's changes into one `edit-delta`, owns the
// last posted sequence, the unanswered-delta flag and the webview refusal counter, and reacts to
// `baseline` and `restore-baseline`. The model session keeps the model, the epoch and the awaiting
// state (Q-17 3.3 A); delta-sync reaches it only through the narrow port below. No edit-sync call
// site uses it yet (007-B). No document text goes to any hook or reason (SR-5).

type EditDeltaMessage = Extract<WebviewMessage, { command: 'edit-delta' }>
type HistoryDeltaMessage = Extract<WebviewMessage, { command: 'history-delta' }>
type HistoryExactMessage = Extract<WebviewMessage, { command: 'history-exact' }>
type ReplayReserveMessage = Extract<
  WebviewMessage,
  { command: 'replay-reserve' }
>
/** Task 733 / 036 (B0): a posted replay operation, kept until the host acknowledges it (3.5). */
type ReplayPost =
  | EditDeltaMessage
  | HistoryDeltaMessage
  | HistoryExactMessage
  | ReplayReserveMessage
/** Task 733 / 036 (B0): the place of a reserved Undo or Redo (its operation and delta sequence). */
interface ReplayReservation {
  epoch: number
  replayOp: number
  sequence: number
}
/** Task 733 / 036 (B0): the publisher every publication goes through while a replay is active. */
export interface LogicalPublisher {
  publish(cause: DeltaCause, perf?: RendererEditPerf): DeltaResult
}
type ModelFallbackReason = Extract<SyncResult, { kind: 'fallback' }>['reason']

/**
 * Why a publication went through the whole-text path. `history-transition` (the model is untrusted after
 * an Undo or Redo), `refusal-limit` (the webview latch), and `host-write` (a host-originated correction
 * left an unanswered delta or a dirty unit) exist only on the delta path.
 */
export type DeltaFallbackReason =
  | ModelFallbackReason
  | 'history-transition'
  | 'refusal-limit'
  | 'host-write'

type DeltaCause = 'idle' | 'overdue' | 'flush' | 'exact'
type DeltaResult = 'delta' | 'nothing' | 'fallback'

/** The part of a unit that the keep rule of `clearForms` reads. */
interface DeltaFormState {
  dirty: boolean
  changedAt: number
}

export type PrepareResult =
  | {
      kind: 'changes'
      before: string
      changes: TextChange[]
      /** A position in `before` at or ahead of the first change, so no scan starts at offset 0. */
      hint?: { offset: number; line: number }
    }
  | { kind: 'fallback'; reason: DeltaFallbackReason }
  | { kind: 'nothing' }

/** What delta-sync needs from the model session (implemented by it in 007-B). */
export interface DeltaSessionPort {
  /**
   * Drain the observer, apply the composition, stale and pre-touch gates, read the model text as
   * `before` and call `sync(sequence)`. The model text already holds the changes when this returns.
   */
  prepareDelta(sequence: number): PrepareResult
  /** The epoch the session holds, or undefined while the model is not live. */
  epoch(): number | undefined
  /** An answer to a whole-text post or a host write is awaited (rule 4.1). */
  awaiting(): boolean
  hasDirty(): boolean
  /** The model text, or undefined while the model is not live. */
  modelText(): string | undefined
  /** New text, same DOM (a restored baseline). */
  rebind(text: string): void
  markPublishedWhole(): void
  clearForms(keep: (unit: DeltaFormState) => boolean): void
  /**
   * Task 733 / 036: a `history-exact` with this sequence was posted; publication waits for its answer. B0:
   * `replay` names its replay operation and the Find record, so the `replay-ack` can complete the wait.
   */
  awaitExactHistory?(
    sequence: number,
    replay?: { epoch: number; replayOp: number; requestId: string },
  ): void
}

export interface DeltaSyncDeps {
  session: DeltaSessionPort
  postMessage(message: ReplayPost): void
  /** Task 733 / 036: a sequence from the whole-edit counter (`edit.sequence`), for `history-exact`. */
  reserveSequence?(): number
  /** The whole-text path with `rebind: true`; the caller records the awaited sequence only. */
  publishWhole(reason: DeltaFallbackReason, perf?: RendererEditPerf): void
  countFallback(reason: DeltaFallbackReason): void
  isComposing(): boolean
  now(): number
  /** A publication is due (a host rebind left typing that the host does not hold). */
  requestPublication?(): void
  /** Bookkeeping that follows a posted delta (anchors, source revision). */
  afterDelta?(): void
}

export interface DeltaSync {
  publish(cause: DeltaCause, perf?: RendererEditPerf): DeltaResult
  /** Call before the session handles the update: counts a refusal and follows the new epoch. */
  onUpdate(message: { epoch?: number; afterSequence?: number }): void
  /** Call before the session handles the rebind. */
  onRebind(message: {
    epoch: number
    afterSequence: number
    content: string
    editSequence?: number
  }): void
  /**
   * Task 004: the text change of one Undo or Redo as a `history-delta` (the unit engine restored the
   * DOM; this syncs the model and posts the change). Whole-text through the same fallbacks as
   * `publish` when the model cannot publish a delta; `'nothing'` when the restore changed no text.
   * The caller refuses Undo during a composition, so none is checked here.
   */
  publishHistory(
    kind: 'undo' | 'redo',
    steps: number,
    exactId?: string,
  ): DeltaResult
  /** The sequence of the last posted delta of the current epoch; 0 when none. */
  lastPostedSequence(): number
  /**
   * Task 733 / 010 (shared rules 3.7): an exact action already applied by units posts its change as
   * one `edit-delta` against `before`. A fallback posts nothing: the caller posts the whole text.
   * `rollback` runs once, from `afterUpdate`, when the host refuses this delta (G9).
   */
  publishApplied(
    before: string,
    changes: readonly TextChange[],
    rollback?: ExactRollback,
  ):
    | { kind: 'delta'; sequence: number }
    | { kind: 'fallback'; reason: DeltaFallbackReason }
  /**
   * Call after the router handled an `update` (Q-79 OQ-4): `shown` true runs the rollback of a refused
   * exact delta; false (the update threw, or a deferred view or a stream keeps it) drops it, so no
   * later, unrelated update runs it.
   */
  afterUpdate(shown: boolean): void
  /**
   * Task 733 / 010 (DR3): the model text the host held at the `afterSequence` of the last `update`
   * that ended the epoch below the deltas posted in it, once; undefined when every delta was answered.
   * The router rebases the unanswered changes past the host change and posts them on the new epoch.
   */
  takeRefusedBase(): string | undefined
  onBaseline(message: { epoch: number; afterSequence: number }): void
  onRestoreBaseline(message: {
    epoch: number
    afterSequence: number
    content: string
  }): void
  /**
   * Task 733 / 036 (B0, 3.5): the host applied the replay operations of `epoch` up to `replayOp`; they leave
   * the ledger, and `acceptedSequence` acknowledges deltas as an `afterSequence` does.
   */
  onReplayAck(message: {
    epoch: number
    replayOp: number
    acceptedSequence: number
  }): void
  /**
   * Task 733 / 036 (B0, 3.5): the answer to `replay-query`. `applied` counts as the acknowledgement;
   * `unknown` re-posts every ledger operation from the queried one, unchanged.
   */
  onReplayStatus(message: {
    epoch: number
    replayOp: number
    state: string
    applied: number
    acceptedSequence: number
  }): void
  /** Task 733 / 036 (B0): the replay operations posted and not acknowledged, ascending. */
  replayLedger(): number[]
  /** Task 733 / 036 (B0): the oldest unacknowledged replay operation, for `replay-query`. */
  oldestReplay(): { epoch: number; replayOp: number } | undefined
  /**
   * Task 733 / 036 (B0, 3.5): a replay delta (typing during a replay) with the shared `sequence` and the next
   * `replayOp`, independent of `awaiting()`. Undefined while no epoch is known.
   */
  postReplayDelta(
    changes: EditDeltaMessage['changes'],
    perf?: RendererEditPerf,
    recoveryOf?: { epoch: number; replayOp: number },
  ): { sequence: number; replayOp: number } | undefined
  /**
   * 036 core C2 (R2.2, R4.2): one ordinary `edit-delta` of `epoch`, posted with the next sequence and no
   * publication gate, for a change the caller proved against the host's bytes of that epoch (each
   * `oldText` read from them, so the host's own `oldText` guard proves it again). False, with nothing
   * posted and nothing cleared, when `epoch` is not the tracked epoch or a change is not well formed.
   */
  postAgainstHost(changes: EditDeltaMessage['changes'], epoch: number): boolean
  /**
   * Task 733 / 036 (B0, review point 1): an untagged Undo or Redo during a replay takes its `replayOp` and
   * its delta sequence at the key and posts `replay-reserve`; later typing follows it in execution order.
   */
  reserveReplayHistory(kind: 'undo' | 'redo'): ReplayReservation | undefined
  /** Task 733 / 036 (B0): the reserved Undo's `history-delta` (`changes` empty when nothing changed). */
  postReservedHistory(
    reservation: ReplayReservation,
    kind: 'undo' | 'redo',
    steps: number,
    changes: EditDeltaMessage['changes'],
  ): void
  /** Task 733 / 036 (B0, 3.5): set while a replay is active; `publish` delegates to it. */
  setLogicalPublisher(publisher: LogicalPublisher | undefined): void
  replayActive(): boolean
  /** Task 733 / 036 (B0): whether `epoch` is newer than the tracked epoch (`host-state`). */
  isNewerEpoch(epoch: number): boolean
}

/** Restores what an exact action changed besides the text when the host refuses it (edit-sync.ts). */
interface ExactRollback {
  restore(): void
}

/** Why a built change list cannot be posted. */
const BUILD_REASON: Record<'too-many' | 'overlap', DeltaFallbackReason> = {
  'too-many': 'too-many-changes',
  overlap: 'sync-error',
}

/** Host limits (SR-1, section 4 of the shared rules). */
const MAX_CHANGES = 256
const MAX_TOTAL_CHARS = 4_000_000
/** Q-11 mirrored: the 5th counted refusal within 10 s latches deltas off for 10 s. */
const REFUSAL_LIMIT = 5
const REFUSAL_WINDOW_MS = 10_000

const normalizeEol = (text: string): string => text.replace(/\r\n?/gu, '\n')

/**
 * Task 733 / 036 (T0): what started a publication. `history` is an Undo or Redo publication; `prepare`
 * is the outstanding-input flush that runs before a history transition (and before a host update).
 */
export type PublicationTraceCause = DeltaCause | 'history' | 'prepare'

/** One publication of the end-to-end trace: kinds and numbers only, never document text (SR-5). */
export interface PublicationTraceEntry {
  kind:
    | 'delta'
    | 'history-delta'
    | 'fallback'
    | 'whole'
    | 'whole-held'
    | 'exact'
    | 'exact-held'
  cause: PublicationTraceCause
  reason?: DeltaFallbackReason
  /** The outcome of the last pre-touch proof of the touched range (from the model session). */
  touched?: TouchedProof
  /** Pending structure windows of the model when the entry was recorded (from the model session). */
  structureDirty?: number
  sequence: number
  t: number
}

/**
 * Task 733 / 036 (T0): the last pre-touch proof of the range an edit touched. `opaque` means the proof
 * passed and a boundary unit of the range is opaque; `none` means no pre-touch proof ran yet.
 */
export type TouchedProof = 'proven' | 'unproven' | 'opaque' | 'none'

/** Task 733 / 036 (T0): the model state each trace entry records, read when the entry is made. */
export interface PublicationTraceContext {
  touched: TouchedProof
  structureDirty: number
}

interface PublicationTraceGlobal {
  __vmdeE2EReadiness?: unknown
  __vmdePublicationTrace?: PublicationTraceEntry[]
}

/** The trace keeps the latest entries only. */
const PUBLICATION_TRACE_LIMIT = 32

// Task 733 / 036 (T0): set by edit-sync while the pre-transition input flush runs, so every
// publication it causes is tagged `prepare` instead of its own cause.
let traceCauseOverride: PublicationTraceCause | undefined
// Task 733 / 036 (T0): the cause of the publication in progress (set by each publisher entry point).
// The whole-text post that a fallback makes runs synchronously inside it and reads the same cause.
let traceCause: PublicationTraceCause = 'idle'
// Task 733 / 036 (T0): registered by the model session in end-to-end runs only.
let traceContext: (() => PublicationTraceContext) | undefined

/** Task 733 / 036 (T0): the reader of the model state for each trace entry (undefined removes it). */
export function setPublicationTraceContext(
  provider: (() => PublicationTraceContext) | undefined,
): void {
  traceContext = provider
}

/** Task 733 / 036 (T0): the registered reader, so its owner removes only its own. */
export function publicationTraceContext():
  | (() => PublicationTraceContext)
  | undefined {
  return traceContext
}

/**
 * Task 733 / 036 (T0): the cause of a publication that starts outside the delta publisher (the
 * whole-text exact post).
 */
export function notePublicationTraceCause(cause: PublicationTraceCause): void {
  traceCause = cause
}

/** Task 733 / 036 (T0): tags the publications until the next call (undefined ends the override). */
export function setPublicationTraceCause(
  cause: PublicationTraceCause | undefined,
): void {
  traceCauseOverride = cause
}

/**
 * Task 733 / 036 (T0): appends one entry to `window.__vmdePublicationTrace`. End-to-end runs only
 * (`__vmdeE2EReadiness` exists): a product page creates no global and allocates nothing here.
 */
export function tracePublication(
  kind: PublicationTraceEntry['kind'],
  sequence: number,
  reason?: DeltaFallbackReason,
): void {
  const slot = globalThis as unknown as PublicationTraceGlobal
  if (!slot.__vmdeE2EReadiness) return
  let trace = slot.__vmdePublicationTrace
  if (!trace) {
    trace = []
    slot.__vmdePublicationTrace = trace
  }
  const entry: PublicationTraceEntry = {
    kind,
    cause: traceCauseOverride ?? traceCause,
    sequence,
    t: Math.round(performance.now()),
  }
  if (reason !== undefined) entry.reason = reason
  if (traceContext) {
    const context = traceContext()
    entry.touched = context.touched
    entry.structureDirty = context.structureDirty
  }
  trace.push(entry)
  if (trace.length > PUBLICATION_TRACE_LIMIT) trace.shift()
}

export function createDeltaSync(deps: DeltaSyncDeps): DeltaSync {
  const { session } = deps
  let trackedEpoch: number | undefined
  let lastPosted = 0
  // Highest `afterSequence` received in the tracked epoch: deltas above it are unanswered.
  let acknowledged = 0
  let forceWhole = false
  let refusals: number[] = []
  let latchedUntil: number | undefined
  // The rollback of the latest exact delta of the epoch until the host answers it, and one that a
  // refusing `update` made due (run by `afterUpdate`, after the editor shows the host text).
  // Ascending by sequence: an earlier exact delta keeps its record when a later one is posted (F8).
  let pendingRollbacks: Array<{ sequence: number; rollback: ExactRollback }> =
    []
  let dueRollback: ExactRollback | undefined
  // The text before each posted delta the host has not answered yet (references, no copy).
  let unanswered: Array<{ sequence: number; before: string }> = []
  let refusedBase: string | undefined
  // Task 733 / 036 (B0): the last `replayOp` of the tracked epoch, the unacknowledged replay operations
  // (the posted messages, by reference, for a re-post after `unknown`), and the logical publisher.
  let lastReplayOp = 0
  let replayLedger: Array<{ replayOp: number; message: ReplayPost }> = []
  let logical: LogicalPublisher | undefined

  function noteUnanswered(before: string): void {
    unanswered.push({ sequence: lastPosted, before })
  }

  /** The session may adopt an epoch without telling us (rebind, outcome); follow it lazily. */
  function followEpoch(): void {
    const epoch = session.epoch()
    if (epoch === undefined || epoch === trackedEpoch) return
    trackedEpoch = epoch
    lastPosted = 0
    acknowledged = 0
    pendingRollbacks = []
    unanswered = []
    resetReplay()
  }

  /** Task 733 / 036 (B0): a new epoch restarts `replayOp` at 1; its unacknowledged operations are refused. */
  function resetReplay(): void {
    lastReplayOp = 0
    if (replayLedger.length > 0) replayLedger = []
  }

  /** Task 733 / 036 (B0): records one posted replay operation of the tracked epoch. */
  function postReplay(message: ReplayPost & { replayOp: number }): void {
    deps.postMessage(message)
    replayLedger.push({ replayOp: message.replayOp, message })
  }

  /** Task 733 / 036 (B0): the host applied the prefix up to `replayOp` and accepted `acceptedSequence`. */
  function acknowledgeReplay(replayOp: number, acceptedSequence: number): void {
    if (replayLedger.length > 0 && replayLedger[0].replayOp <= replayOp)
      replayLedger = replayLedger.filter((entry) => entry.replayOp > replayOp)
    if (acceptedSequence > acknowledged) acknowledged = acceptedSequence
    acknowledgeRollback(acceptedSequence)
  }

  /** The host answered up to `afterSequence` in the tracked epoch: an exact delta it covers stays. */
  function acknowledgeRollback(afterSequence: number): void {
    if (unanswered.length > 0)
      unanswered = unanswered.filter(
        (record) => record.sequence > afterSequence,
      )
    if (pendingRollbacks.length === 0) return
    pendingRollbacks = pendingRollbacks.filter(
      (record) => record.sequence > afterSequence,
    )
  }

  function isLatched(): boolean {
    if (latchedUntil === undefined) return false
    if (deps.now() < latchedUntil) return true
    latchedUntil = undefined
    refusals = []
    return false
  }

  function countRefusal(): void {
    const now = deps.now()
    refusals = refusals.filter((t) => now - t < REFUSAL_WINDOW_MS)
    refusals.push(now)
    if (refusals.length >= REFUSAL_LIMIT) latchedUntil = now + REFUSAL_WINDOW_MS
  }

  function fallback(
    reason: DeltaFallbackReason,
    perf?: RendererEditPerf,
  ): 'fallback' {
    deps.countFallback(reason)
    tracePublication('fallback', lastPosted, reason)
    // A plain whole-text post carries the DOM, the action included: a refusal no longer rolls it back,
    // and no delta before it needs posting again.
    pendingRollbacks = []
    unanswered = []
    deps.publishWhole(reason, perf)
    session.markPublishedWhole()
    return 'fallback'
  }

  /** Message for `changes` against `before`, or undefined when the limits are exceeded. */
  function buildChanges(
    before: string,
    raw: readonly TextChange[],
    hint?: { offset: number; line: number },
  ): EditDeltaMessage['changes'] | 'too-many' | 'overlap' {
    if (raw.length > MAX_CHANGES) return 'too-many'
    let total = 0
    for (const change of raw) {
      total += change.to - change.from + change.insert.length
    }
    if (total > MAX_TOTAL_CHARS) return 'too-many'
    const out: EditDeltaMessage['changes'] = []
    let previousEnd: { offset: number; line: number } | undefined = hint
    let previousTo = 0
    for (const original of raw) {
      const change = widenToCodePoints(before, original)
      // Widening can make two neighbours touch inside one pair; the host refuses overlap.
      if (change.from < previousTo) return 'overlap'
      const oldText = before.slice(change.from, change.to)
      if (oldText === change.insert) continue
      const start: LinePosition = offsetToPosition(
        before,
        change.from,
        previousEnd,
      )
      const end = offsetToPosition(before, change.to, {
        offset: change.from,
        line: start.line,
      })
      out.push({ start, end, oldText, text: change.insert })
      previousEnd = { offset: change.to, line: end.line }
      previousTo = change.to
    }
    return joinTouching(out)
  }

  function post(
    epoch: number,
    changes: EditDeltaMessage['changes'],
    perf?: RendererEditPerf,
  ): void {
    lastPosted += 1
    const message: EditDeltaMessage = {
      command: 'edit-delta',
      epoch,
      sequence: lastPosted,
      changes,
    }
    if (perf) message.perf = perf
    deps.postMessage(message)
    tracePublication('delta', lastPosted)
  }

  /** The gates before any draining: a result when the publication is decided without the model. */
  function gate(
    cause: DeltaCause,
    perf: RendererEditPerf | undefined,
  ): DeltaResult | undefined {
    if (deps.isComposing() && cause !== 'flush') return 'nothing'
    followEpoch()
    if (session.epoch() === undefined) return fallback('model-off', perf)
    if (session.awaiting()) {
      if (cause === 'idle' || cause === 'overdue') return 'nothing'
      return fallback('awaiting-rebind', perf)
    }
    if (isLatched()) return fallback('refusal-limit', perf)
    return undefined
  }

  function publishPrepared(
    epoch: number,
    prepared: PrepareResult,
    perf: RendererEditPerf | undefined,
    send: (changes: EditDeltaMessage['changes']) => void = (changes) =>
      post(epoch, changes, perf),
  ): DeltaResult {
    if (prepared.kind === 'nothing') return 'nothing'
    if (prepared.kind === 'fallback') {
      forceWhole = false
      return fallback(prepared.reason, perf)
    }
    const changes = buildChanges(
      prepared.before,
      prepared.changes,
      prepared.hint,
    )
    if (changes === 'too-many') return fallback('too-many-changes', perf)
    if (changes === 'overlap') return fallback('sync-error', perf)
    if (changes.length === 0) return 'nothing'
    send(changes)
    noteUnanswered(prepared.before)
    return 'delta'
  }

  function postHistory(
    kind: 'undo' | 'redo',
    steps: number,
    epoch: number,
    changes: EditDeltaMessage['changes'],
  ): void {
    lastPosted += 1
    deps.postMessage({
      command: 'history-delta',
      kind,
      epoch,
      sequence: lastPosted,
      steps,
      changes,
    })
    tracePublication('history-delta', lastPosted)
  }

  function publishHistory(
    kind: 'undo' | 'redo',
    steps: number,
    exactId?: string,
  ): DeltaResult {
    traceCause = 'history'
    followEpoch()
    // Task 733 / 036 (F6): a replayable Find entry is replayed by the host from its admitted pair. This
    // runs before the awaiting, latch and `forceWhole` fallbacks, so no earlier post turns it into whole
    // text; it skips `prepareDelta` and keeps the rollback records and unanswered deltas.
    // B0: the move is the next replay operation of the tracked epoch (3.1); without an epoch it cannot be
    // addressed and goes whole-text as the model-off Undo does.
    if (exactId !== undefined && deps.reserveSequence) {
      const epoch = trackedEpoch
      if (epoch === undefined) return fallback('history-transition')
      const sequence = deps.reserveSequence()
      lastReplayOp += 1
      const replayOp = lastReplayOp
      postReplay({
        command: 'history-exact',
        kind,
        requestId: exactId,
        sequence,
        epoch,
        replayOp,
      })
      session.awaitExactHistory?.(sequence, {
        epoch,
        replayOp,
        requestId: exactId,
      })
      return 'delta'
    }
    const epoch = session.epoch()
    // Whole-text, as `publish` would, but the model-off case is the Undo's own reason.
    if (epoch === undefined) return fallback('history-transition')
    if (session.awaiting()) return fallback('awaiting-rebind')
    if (isLatched()) return fallback('refusal-limit')
    if (forceWhole) {
      forceWhole = false
      return fallback('host-write')
    }
    return publishPrepared(
      epoch,
      session.prepareDelta(lastPosted + 1),
      undefined,
      (changes) => {
        postHistory(kind, steps, epoch, changes)
        pendingRollbacks = []
        deps.afterDelta?.()
      },
    )
  }

  function publish(cause: DeltaCause, perf?: RendererEditPerf): DeltaResult {
    traceCause = cause
    // Task 733 / 036 (B0, 3.5): while a replay is active every publication goes through its publisher.
    if (logical) return logical.publish(cause, perf)
    const decided = gate(cause, perf)
    if (decided) return decided
    const epoch = session.epoch()
    if (epoch === undefined) return 'nothing'
    // A host write left typing that the host does not hold: the DOM goes whole-text whether or not
    // the model sees a change (its text was rebound to the host bytes, which lack that typing).
    if (forceWhole) {
      forceWhole = false
      return fallback('host-write', perf)
    }
    const result = publishPrepared(
      epoch,
      session.prepareDelta(lastPosted + 1),
      perf,
    )
    // Typing published after an exact delta is in the DOM: a refusal keeps it, as the whole-text rule
    // does for a plain post after the exact one (`plainAfter`, 010-R F9).
    if (result === 'delta') pendingRollbacks = []
    return result
  }

  /** The gates of an applied exact action, in the order of `publish`; undefined when it may post. */
  function appliedGate(): DeltaFallbackReason | undefined {
    if (session.epoch() === undefined) return 'model-off'
    if (session.awaiting()) return 'awaiting-rebind'
    if (isLatched()) return 'refusal-limit'
    if (!forceWhole) return undefined
    forceWhole = false
    return 'host-write'
  }

  function publishApplied(
    before: string,
    changes: readonly TextChange[],
    rollback?: ExactRollback,
  ):
    | { kind: 'delta'; sequence: number }
    | { kind: 'fallback'; reason: DeltaFallbackReason } {
    traceCause = 'exact'
    followEpoch()
    const gated = appliedGate()
    const built = gated === undefined ? buildChanges(before, changes) : 'gated'
    const epoch = session.epoch()
    if (typeof built === 'string' || epoch === undefined) {
      const why =
        gated ??
        (built === 'too-many' || built === 'overlap'
          ? BUILD_REASON[built]
          : 'model-off')
      deps.countFallback(why)
      tracePublication('fallback', lastPosted, why)
      return { kind: 'fallback', reason: why }
    }
    if (built.length === 0) return { kind: 'delta', sequence: lastPosted }
    post(epoch, built)
    noteUnanswered(before)
    if (rollback) pendingRollbacks.push({ sequence: lastPosted, rollback })
    deps.afterDelta?.()
    return { kind: 'delta', sequence: lastPosted }
  }

  function postReplayDelta(
    changes: EditDeltaMessage['changes'],
    perf?: RendererEditPerf,
    recoveryOf?: { epoch: number; replayOp: number },
  ): { sequence: number; replayOp: number } | undefined {
    followEpoch()
    const epoch = trackedEpoch
    if (epoch === undefined) return undefined
    lastPosted += 1
    lastReplayOp += 1
    const message: EditDeltaMessage & { replayOp: number } = {
      command: 'edit-delta',
      epoch,
      sequence: lastPosted,
      changes,
      replayOp: lastReplayOp,
    }
    if (perf) message.perf = perf
    if (recoveryOf) message.recoveryOf = recoveryOf
    postReplay(message)
    tracePublication('delta', lastPosted)
    return { sequence: lastPosted, replayOp: lastReplayOp }
  }

  function postAgainstHost(
    changes: EditDeltaMessage['changes'],
    epoch: number,
  ): boolean {
    followEpoch()
    if (epoch !== trackedEpoch || changes.length === 0) return false
    for (const change of changes) if (!wellFormed(change)) return false
    post(epoch, changes)
    deps.afterDelta?.()
    return true
  }

  function reserveReplayHistory(
    kind: 'undo' | 'redo',
  ): ReplayReservation | undefined {
    followEpoch()
    const epoch = trackedEpoch
    if (epoch === undefined) return undefined
    lastPosted += 1
    lastReplayOp += 1
    const reservation = { epoch, replayOp: lastReplayOp, sequence: lastPosted }
    postReplay({
      command: 'replay-reserve',
      epoch,
      replayOp: reservation.replayOp,
      kind,
    })
    return reservation
  }

  function postReservedHistory(
    reservation: ReplayReservation,
    kind: 'undo' | 'redo',
    steps: number,
    changes: EditDeltaMessage['changes'],
  ): void {
    followEpoch()
    // A reservation of an ended epoch was refused with it; its content is not posted.
    if (reservation.epoch !== trackedEpoch) return
    const message: HistoryDeltaMessage & { replayOp: number } = {
      command: 'history-delta',
      kind,
      epoch: reservation.epoch,
      sequence: reservation.sequence,
      steps,
      changes,
      replayOp: reservation.replayOp,
    }
    deps.postMessage(message)
    // The ledger keeps the content in place of the reservation, for a re-post after `unknown`.
    const entry = replayLedger.find(
      (record) => record.replayOp === reservation.replayOp,
    )
    if (entry) entry.message = message
    tracePublication('history-delta', reservation.sequence)
  }

  function restoreBaseline(message: {
    epoch: number
    afterSequence: number
    content: string
  }): void {
    if (session.epoch() !== message.epoch) return
    if (message.afterSequence !== lastPosted) return
    if (session.hasDirty() || session.awaiting() || isLatched()) return
    const text = session.modelText()
    if (text === undefined) return
    const content = normalizeEol(message.content)
    const diff = singleSpanDiff(text, content)
    if (!diff) return
    const changes = buildChanges(text, [diff])
    if (typeof changes === 'string' || changes.length === 0) return
    post(message.epoch, changes)
    noteUnanswered(text)
    session.rebind(content)
    deps.afterDelta?.()
  }

  return {
    publish,
    publishHistory,
    publishApplied,
    postReplayDelta,
    postAgainstHost,
    reserveReplayHistory,
    postReservedHistory,
    onReplayAck(message) {
      followEpoch()
      if (message.epoch !== trackedEpoch) return
      acknowledgeReplay(message.replayOp, message.acceptedSequence)
    },
    onReplayStatus(message) {
      followEpoch()
      // Authoritative for its named epoch only (second-opinion point 2).
      if (message.epoch !== trackedEpoch) return
      if (message.state === 'applied') {
        acknowledgeReplay(message.applied, message.acceptedSequence)
        return
      }
      if (message.state !== 'unknown') return
      for (const entry of replayLedger)
        if (entry.replayOp >= message.replayOp) deps.postMessage(entry.message)
    },
    replayLedger: () => replayLedger.map((entry) => entry.replayOp),
    oldestReplay() {
      const oldest = replayLedger[0]
      return oldest === undefined || trackedEpoch === undefined
        ? undefined
        : { epoch: trackedEpoch, replayOp: oldest.replayOp }
    },
    setLogicalPublisher(publisher) {
      logical = publisher
    },
    replayActive: () => logical !== undefined,
    isNewerEpoch(epoch) {
      followEpoch()
      return trackedEpoch === undefined || epoch > trackedEpoch
    },
    takeRefusedBase() {
      const base = refusedBase
      refusedBase = undefined
      return base
    },
    afterUpdate(shown) {
      refusedBase = undefined
      const due = dueRollback
      dueRollback = undefined
      if (shown) due?.restore()
    },
    lastPostedSequence() {
      followEpoch()
      return lastPosted
    },
    onUpdate(message) {
      followEpoch()
      const epoch = message.epoch ?? 0
      if (epoch === trackedEpoch) {
        if (message.afterSequence !== undefined) {
          acknowledged = Math.max(acknowledged, message.afterSequence)
          acknowledgeRollback(message.afterSequence)
        }
        return
      }
      // G9: the epoch ended below the exact delta's sequence, so the host refused it. The earliest
      // refused exact delta restores the state before every later one.
      const refused = pendingRollbacks.find(
        (record) => record.sequence > (message.afterSequence ?? 0),
      )
      if (refused) dueRollback = refused.rollback
      pendingRollbacks = []
      // Otherwise the host text answers up to `afterSequence`, and the changes posted after it are
      // re-applied on the new epoch from the text before the first of them (DR3).
      refusedBase =
        !refused &&
        message.afterSequence !== undefined &&
        message.afterSequence < lastPosted
          ? unanswered.find(
              (record) => record.sequence > message.afterSequence!,
            )?.before
          : undefined
      unanswered = []
      // A new epoch: a posted delta that the host did not apply counts as one refusal (Q-11).
      if (
        message.afterSequence !== undefined &&
        message.afterSequence < lastPosted
      )
        countRefusal()
      trackedEpoch = epoch
      lastPosted = 0
      acknowledged = 0
      forceWhole = false
      resetReplay()
    },
    onRebind(message) {
      followEpoch()
      // The same epoch: an answer to our own whole-text post (the session handles it); its count tells which
      // deltas the host accepted.
      if (message.epoch === trackedEpoch) {
        acknowledged = Math.max(acknowledged, message.afterSequence)
        acknowledgeRollback(message.afterSequence)
        return
      }
      if (message.editSequence !== undefined) return
      // Posted deltas the host did not report as accepted are lost only when the host text differs from
      // the model text, which holds all of them; equal texts mean the host applied everything.
      const lost =
        lastPosted > acknowledged &&
        session.modelText() !== normalizeEol(message.content)
      trackedEpoch = message.epoch
      lastPosted = 0
      acknowledged = 0
      resetReplay()
      // A host-own rebind keeps the DOM, which still shows the action: no record survives the epoch
      // (the forced whole publication below carries the action), 010-R N4.
      pendingRollbacks = []
      unanswered = []
      if (lost || session.hasDirty()) {
        forceWhole = true
        deps.requestPublication?.()
      }
    },
    onBaseline(message) {
      followEpoch()
      // Task 733 / 036 (B0, 3.5): the forms belong to the replay until it ends.
      if (logical) return
      if (session.epoch() !== message.epoch) return
      const exact =
        message.afterSequence === lastPosted &&
        !session.hasDirty() &&
        !session.awaiting()
      // Exact: nothing pending, so every form is clean. Otherwise only forms of clean units that no
      // delta after `afterSequence` changed (rule 4).
      session.clearForms((unit) =>
        exact ? false : unit.dirty || unit.changedAt > message.afterSequence,
      )
    },
    onRestoreBaseline(message) {
      followEpoch()
      // Task 733 / 036 (B0, 3.5): the replay owns the text until it ends.
      if (!logical) restoreBaseline(message)
    },
  }
}

/** 036 core C2: a change of the `edit-delta` shape with whole, ordered, non-negative positions. */
function wellFormed(change: EditDeltaMessage['changes'][number]): boolean {
  const { start, end } = change
  return (
    typeof change.oldText === 'string' &&
    typeof change.text === 'string' &&
    Number.isInteger(start.line) &&
    Number.isInteger(start.character) &&
    Number.isInteger(end.line) &&
    Number.isInteger(end.character) &&
    start.line >= 0 &&
    start.character >= 0 &&
    (end.line > start.line ||
      (end.line === start.line && end.character >= start.character))
  )
}

/**
 * Task 733 / 034: a change that starts where the previous one ends joins it. Two insertions at one
 * point (a table column insert) have no defined order, and the host refuses them (`checkOrder`,
 * 'order'), resynchronizes, and the history is lost. O(changes); only touching changes allocate a
 * joined one.
 */
function joinTouching(
  changes: EditDeltaMessage['changes'],
): EditDeltaMessage['changes'] {
  for (let i = changes.length - 1; i > 0; i -= 1) {
    const last = changes[i - 1]
    const next = changes[i]
    if (
      next.start.line !== last.end.line ||
      next.start.character !== last.end.character
    )
      continue
    changes.splice(i - 1, 2, {
      start: last.start,
      end: next.end,
      oldText: last.oldText + next.oldText,
      text: last.text + next.text,
    })
  }
  return changes
}
