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
}

export interface DeltaSyncDeps {
  session: DeltaSessionPort
  postMessage(message: EditDeltaMessage | HistoryDeltaMessage): void
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
  publishHistory(kind: 'undo' | 'redo', steps: number): DeltaResult
  /** The sequence of the last posted delta of the current epoch; 0 when none. */
  lastPostedSequence(): number
  onBaseline(message: { epoch: number; afterSequence: number }): void
  onRestoreBaseline(message: {
    epoch: number
    afterSequence: number
    content: string
  }): void
}

/** Host limits (SR-1, section 4 of the shared rules). */
const MAX_CHANGES = 256
const MAX_TOTAL_CHARS = 4_000_000
/** Q-11 mirrored: the 5th counted refusal within 10 s latches deltas off for 10 s. */
const REFUSAL_LIMIT = 5
const REFUSAL_WINDOW_MS = 10_000

const normalizeEol = (text: string): string => text.replace(/\r\n?/gu, '\n')

export function createDeltaSync(deps: DeltaSyncDeps): DeltaSync {
  const { session } = deps
  let trackedEpoch: number | undefined
  let lastPosted = 0
  // Highest `afterSequence` received in the tracked epoch: deltas above it are unanswered.
  let acknowledged = 0
  let forceWhole = false
  let refusals: number[] = []
  let latchedUntil: number | undefined

  /** The session may adopt an epoch without telling us (rebind, outcome); follow it lazily. */
  function followEpoch(): void {
    const epoch = session.epoch()
    if (epoch === undefined || epoch === trackedEpoch) return
    trackedEpoch = epoch
    lastPosted = 0
    acknowledged = 0
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
    return out
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
  }

  function publishHistory(kind: 'undo' | 'redo', steps: number): DeltaResult {
    followEpoch()
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
        deps.afterDelta?.()
      },
    )
  }

  function publish(cause: DeltaCause, perf?: RendererEditPerf): DeltaResult {
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
    return publishPrepared(epoch, session.prepareDelta(lastPosted + 1), perf)
  }

  return {
    publish,
    publishHistory,
    lastPostedSequence() {
      followEpoch()
      return lastPosted
    },
    onUpdate(message) {
      followEpoch()
      const epoch = message.epoch ?? 0
      if (epoch === trackedEpoch) {
        if (message.afterSequence !== undefined)
          acknowledged = Math.max(acknowledged, message.afterSequence)
        return
      }
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
    },
    onRebind(message) {
      followEpoch()
      // The same epoch: an answer to our own whole-text post (the session handles it); its count tells which
      // deltas the host accepted.
      if (message.epoch === trackedEpoch) {
        acknowledged = Math.max(acknowledged, message.afterSequence)
        return
      }
      if (message.editSequence !== undefined) return
      // Posted deltas the host did not report as accepted are lost only when the host text differs from
      // the model text, which holds all of them; equal texts mean the host applied everything.
      const unanswered =
        lastPosted > acknowledged &&
        session.modelText() !== normalizeEol(message.content)
      trackedEpoch = message.epoch
      lastPosted = 0
      acknowledged = 0
      if (unanswered || session.hasDirty()) {
        forceWhole = true
        deps.requestPublication?.()
      }
    },
    onBaseline(message) {
      followEpoch()
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
      session.rebind(content)
      deps.afterDelta?.()
    },
  }
}
