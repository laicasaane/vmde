import type { Page } from '@playwright/test'

// Task 733 / 024 (plan D-14 section 4.1, Q-140): a host stand-in for the Chromium harness smoke
// stage. It keeps the host text, applies the webview's `edit`, `edit-delta` and `history-delta` posts
// as the host does, answers an `edit` with `rebind: true` once (the host's `answerRebind`), and
// resynchronizes with one `update` of a new epoch when a delta does not match (shared rules 3.6).
// Task 733 / 019 (Q-161): a `history-transition` whose `before` is the host text makes `after` the host
// text, as the host's history coupling does; any other `before` resynchronizes. `holdRebind` records a
// rebind request and leaves it unanswered, so the model stays waiting.
// Task 733 / 022: `releaseRebind` sends the held answer, with the host text of the held request.
// Task 733 / 036: an `edit` with `exact`, `rebind` and `replayable` admits a replay pair (FIFO of 8); its
// rebind names the pair (`exactRequestId`) and any pair dropped (`exactEvicted`). A `history-exact` whose
// start side is the host text replays the pair; anything else, a `refuseExact` stub, and a
// `replay-abandon` of the current epoch resynchronize with one `update`.
// Task 733 / 036 (B0): every post with `replayOp` is a replay operation of its epoch, checked as the host
// does (stale epoch dropped, duplicate re-acknowledged, gap refused) and answered with `replay-ack` of the
// contiguous applied prefix; `replay-query` gets `replay-status` and `host-state-query` gets `host-state`.
// Task 733 / 036 step H: `exactReplyDelayMs` answers a replayed `history-exact` that many milliseconds
// late. Every post is logged as kind, time and outcome only (`ops`), with the time the stub spent on it,
// so a timed window ends at the stub's observed application without reading the host text.
// Task 733 / 036 step H2: the time of the last `replay-ack` (or `replay-status` with `applied`) as the
// page receives it, the highest replay operation posted and acknowledged in the current epoch, and the
// number of `replay-status` answers with `unknown`, so a window ends at the acknowledgement.
// Not modelled: save, `exact-authority`, epochs across a reload, restart memory (run 1 covers them).
// Every other post is recorded by its kind only; no text is kept beyond the host text.

export interface HostStubState {
  text: string
  epoch: number
  accepted: number
  resyncs: number
  rebinds: number
  /** Task 733 / 019: `history-transition` posts the stub applied. */
  transitions: number
  /** Task 733 / 036: `history-exact` posts the stub replayed. */
  exactReplays: number
  /** Task 733 / 036 step H: history operations: `history-exact` posts and `edit` posts with `history`. */
  historyOps: number
  /** Task 733 / 036 step H: `edit` posts that carry `history` (the exact recovery of an evicted pair). */
  historyEdits: number
  /** Task 733 / 036 step H: `performance.now()` of the last post the stub handled; -1 before the first. */
  lastOpAt: number
  /** Task 733 / 036 step H: every post as kind, receive time, handling time (ms) and outcome. */
  ops: HostStubOp[]
  kinds: string[]
  /** Task 733 / 036 step H2: `performance.now()` at the page's receipt of the last acknowledgement; -1 before. */
  lastAckAt: number
  /** Task 733 / 036 step H2: acknowledgements received (`replay-ack`, or `replay-status` with `applied`). */
  acks: number
  /** Task 733 / 036 step H2: the highest replay operation acknowledged in the current epoch (0: none). */
  lastAckOp: number
  /** Task 733 / 036 step H2: the highest replay operation posted in the current epoch (0: none). */
  lastReplayOp: number
  /** Task 733 / 036 step H2: `replay-status` answers with `unknown`. */
  unknownStatuses: number
  /**
   * Task 733 / 036 D-18: `flush-for-save` requests the stub sent (`__vmdeHostStubFlush`) and the
   * `flush-for-save-done` replies, each with the host text when the reply arrived (the bytes Save writes).
   */
  flushRequests: string[]
  /** Task 733 C1: `performance.now()` of each `flush-for-save` request, so both flush endpoints are timed. */
  flushRequestTimes: number[]
  flushReplies: Array<{ requestId: string; at: number; text: string }>
  /**
   * 036 core C10 (T6a, C10 review item 2): every `history-exact` post as its `sequence` and receive time,
   * so a measured move is matched to its own completion. Numbers only.
   */
  exactPosts: Array<{ sequence: number; at: number }>
}

/** Task 733 / 036 step H: one handled post; no text. */
export interface HostStubOp {
  kind: string
  at: number
  ms: number
  outcome: 'applied' | 'resync' | 'replayed' | 'recorded'
}

/** Task 733 / 036 step H: the stub's state without the host text, for reads inside a timed window. */
export type HostStubCounters = Omit<HostStubState, 'text'>

/** Installs the stub's `acquireVsCodeApi` before the page's scripts run; `ready` gets the `init` update. */
export async function installHostStub(
  page: Page,
  init: {
    content: string
    options?: Record<string, unknown>
    /** Task 733 / 019 (Q-161): record a rebind request and leave it unanswered. */
    holdRebind?: boolean
    /** Task 733 / 036: refuse every `history-exact` with one `update`. */
    refuseExact?: boolean
    /** Task 733 / 036 step H: answer a replayed `history-exact` this many milliseconds late (0: at once). */
    exactReplyDelayMs?: number
  },
): Promise<void> {
  await page.addInitScript(
    (setup) => {
      type Position = { line: number; character: number }
      type Change = {
        start: Position
        end: Position
        oldText: string
        text: string
      }
      const state = {
        text: setup.content,
        epoch: 0,
        accepted: 0,
        resyncs: 0,
        rebinds: 0,
        transitions: 0,
        exactReplays: 0,
        historyOps: 0,
        historyEdits: 0,
        lastOpAt: -1,
        ops: [] as Array<{
          kind: string
          at: number
          ms: number
          outcome: 'applied' | 'resync' | 'replayed' | 'recorded'
        }>,
        kinds: [] as string[],
        lastAckAt: -1,
        acks: 0,
        lastAckOp: 0,
        lastReplayOp: 0,
        unknownStatuses: 0,
        flushRequests: [] as string[],
        flushRequestTimes: [] as number[],
        flushReplies: [] as Array<{
          requestId: string
          at: number
          text: string
        }>,
        exactPosts: [] as Array<{ sequence: number; at: number }>,
      }
      // Task 733 / 036 step H2: an acknowledgement is timed when the page receives it, as the webview does.
      window.addEventListener('message', (event) => {
        const data = event.data
        const acked =
          data?.command === 'replay-ack' ||
          (data?.command === 'replay-status' && data.state === 'applied')
        if (!acked || data.epoch !== state.epoch) return
        state.lastAckAt = performance.now()
        state.acks++
        if (typeof data.replayOp === 'number')
          state.lastAckOp = Math.max(state.lastAckOp, data.replayOp)
      })
      // Task 733 / 036 step H: the outcome of the post being handled, read by `receive` for its log entry.
      let outcome: 'applied' | 'resync' | 'replayed' | 'recorded' = 'recorded'
      // Task 733 / 036: the admitted replay pairs, oldest first (the host's FIFO of 8).
      const pairs: Array<{ requestId: string; before: string; after: string }> =
        []
      // The last accepted delta sequence of the current epoch (the host's `acceptedSequence`).
      let lastSequence = 0
      // Task 733 / 036 (B0): the replay prefix of the current epoch, whether the epoch carried replay
      // operations, reserved operations, and the outcome of the last ended epoch.
      let replayApplied = 0
      let replayCarried = false
      const reserved = new Set<number>()
      let ended:
        | {
            epoch: number
            applied: number
            accepted: number
            refused?: number
          }
        | undefined
      let refusing: number | undefined
      ;(window as any).__vmdeHostStub = state
      const answer = (message: unknown) => window.postMessage(message, '*')

      /** The offset of `position` in `text` (`\n` line endings), or -1 when it is outside the text. */
      const offsetOf = (text: string, position: Position): number => {
        let offset = 0
        for (let line = 0; line < position.line; line++) {
          const next = text.indexOf('\n', offset)
          if (next < 0) return -1
          offset = next + 1
        }
        const lineEnd = text.indexOf('\n', offset)
        const end = lineEnd < 0 ? text.length : lineEnd
        return offset + position.character <= end
          ? offset + position.character
          : -1
      }

      /** The text after `changes` (ranges of the pre-edit text), or undefined when one does not match. */
      const applied = (changes: Change[]): string | undefined => {
        const ranges: Array<{ from: number; to: number; text: string }> = []
        let previousTo = 0
        for (const change of changes) {
          const from = offsetOf(state.text, change.start)
          const to = offsetOf(state.text, change.end)
          if (from < previousTo || to < from) return undefined
          if (state.text.slice(from, to) !== change.oldText) return undefined
          ranges.push({ from, to, text: change.text })
          previousTo = to
        }
        let out = state.text
        for (let i = ranges.length - 1; i >= 0; i--)
          out =
            out.slice(0, ranges[i].from) +
            ranges[i].text +
            out.slice(ranges[i].to)
        return out
      }

      const resync = () => {
        outcome = 'resync'
        state.resyncs++
        ended = {
          epoch: state.epoch,
          applied: replayApplied,
          accepted: lastSequence,
          ...(refusing === undefined ? {} : { refused: refusing }),
        }
        const replayAfterOp = replayCarried ? replayApplied : undefined
        state.epoch++
        const afterSequence = lastSequence
        lastSequence = 0
        replayApplied = 0
        replayCarried = false
        refusing = undefined
        reserved.clear()
        state.lastAckOp = 0
        state.lastReplayOp = 0
        answer({
          command: 'update',
          type: 'update',
          content: state.text,
          epoch: state.epoch,
          afterSequence,
          ...(replayAfterOp === undefined ? {} : { replayAfterOp }),
        })
      }

      const replayAck = () =>
        answer({
          command: 'replay-ack',
          epoch: state.epoch,
          replayOp: replayApplied,
          acceptedSequence: lastSequence,
        })

      // Task 733 / 036 (B0): the host's order of checks (fix design 3.3) around `run`, which returns
      // whether the operation applied. Posts without `replayOp` run as before.
      const asReplay = (
        posted: any,
        run: () => boolean,
        ack: () => void = replayAck,
      ) => {
        if (typeof posted.replayOp !== 'number') {
          run()
          return
        }
        if (posted.epoch !== state.epoch) return
        replayCarried = true
        reserved.delete(posted.replayOp)
        state.lastReplayOp = Math.max(state.lastReplayOp, posted.replayOp)
        if (posted.replayOp <= replayApplied) {
          replayAck()
          return
        }
        if (posted.replayOp > replayApplied + 1) {
          refusing = posted.replayOp
          resync()
          return
        }
        if (!run()) return
        replayApplied = posted.replayOp
        ack()
      }

      const onReady = () =>
        answer({
          command: 'update',
          type: 'init',
          content: setup.content,
          cdn: '/vditor',
          options: setup.options,
          theme: 'light',
          wiki: { enabled: false },
          e2e: true,
          epoch: 0,
        })

      // Task 733 / 036: a replayable exact post that changed the text admits its pair; the rebind names
      // it, and the pair the FIFO of 8 dropped.
      const admit = (
        posted: any,
        held: string,
      ): { exactRequestId?: string; exactEvicted?: string } => {
        if (
          posted.exact !== true ||
          posted.replayable !== true ||
          typeof posted.requestId !== 'string' ||
          posted.before !== held ||
          posted.content === held
        )
          return {}
        pairs.push({
          requestId: posted.requestId,
          before: held,
          after: posted.content,
        })
        const evicted = pairs.length > 8 ? pairs.shift()?.requestId : undefined
        return evicted === undefined
          ? { exactRequestId: posted.requestId }
          : { exactRequestId: posted.requestId, exactEvicted: evicted }
      }

      // Task 733 / 036 step H: an `edit` with `history` is the exact recovery of an evicted pair.
      const countHistoryEdit = (posted: any) => {
        if (posted.history !== 'undo' && posted.history !== 'redo') return
        state.historyEdits++
        state.historyOps++
      }

      // A whole-text edit; one with `rebind: true` is answered once, as the host's `answerRebind`.
      const onEdit = (posted: any) =>
        asReplay(posted, () => {
          applyEdit(posted)
          return true
        })
      const applyEdit = (posted: any) => {
        const held = state.text
        state.text = posted.content
        state.accepted++
        outcome = 'applied'
        countHistoryEdit(posted)
        if (posted.rebind !== true) return
        state.rebinds++
        const editSequence =
          typeof posted.sequence === 'number' ? posted.sequence : undefined
        const admitted = admit(posted, held)
        const rebind = {
          command: 'rebind',
          epoch: state.epoch,
          afterSequence: lastSequence,
          content: state.text,
          ...(editSequence === undefined ? {} : { editSequence }),
          ...admitted,
        }
        if (setup.holdRebind) {
          heldRebind = rebind
          return
        }
        answer(rebind)
      }
      // Task 733 / 022: the held answer, sent by `releaseRebind`.
      let heldRebind: unknown
      // Task 733 / 036 D-18: the host's Save asks the page to flush (`flush-for-save`); the reply records
      // the host text it arrives with, which is what Save writes to disk.
      ;(window as any).__vmdeHostStubFlush = (requestId: string): void => {
        state.flushRequests.push(requestId)
        state.flushRequestTimes.push(performance.now())
        answer({ command: 'flush-for-save', requestId })
      }
      ;(window as any).__vmdeHostStubReleaseRebind = (): boolean => {
        if (heldRebind === undefined) return false
        answer(heldRebind)
        heldRebind = undefined
        return true
      }

      // An `edit-delta` or `history-delta`: accepted on the current epoch and the next sequence when
      // every `oldText` matches, else answered by a resynchronization.
      const onDelta = (posted: any) =>
        asReplay(posted, () => applyDelta(posted))
      const applyDelta = (posted: any): boolean => {
        // An empty history delta: a reserved Undo whose restore changed no text consumes its sequence.
        if (
          Array.isArray(posted.changes) &&
          posted.changes.length === 0 &&
          posted.command === 'history-delta' &&
          posted.epoch === state.epoch &&
          posted.sequence === lastSequence + 1
        ) {
          lastSequence = posted.sequence
          outcome = 'applied'
          return true
        }
        const inOrder =
          posted.epoch === state.epoch &&
          posted.sequence === lastSequence + 1 &&
          Array.isArray(posted.changes)
        const next = inOrder ? applied(posted.changes) : undefined
        if (next === undefined) {
          if (typeof posted.replayOp === 'number') refusing = posted.replayOp
          resync()
          return false
        }
        state.text = next
        lastSequence = posted.sequence
        state.accepted++
        outcome = 'applied'
        return true
      }

      // A `history-transition`: applied when `before` is the host text, else answered by a resync.
      const onTransition = (posted: any) => {
        if (
          typeof posted.before !== 'string' ||
          typeof posted.after !== 'string' ||
          posted.before !== state.text
        ) {
          resync()
          return
        }
        state.text = posted.after
        state.transitions++
        outcome = 'applied'
        // Task 733 / 022: a transition that carries a sequence is answered once with the host bytes,
        // as the host's `answerRebind` (src/session/editor-session.ts).
        if (typeof posted.sequence === 'number')
          answer({
            command: 'rebind',
            epoch: state.epoch,
            afterSequence: lastSequence,
            content: state.text,
            editSequence: posted.sequence,
          })
      }

      // Task 733 / 036: a `history-exact` replays its pair when the start side is the host text. B0: it is
      // answered by `replay-ack`, not `rebind` (a delayed answer after `exactReplyDelayMs`).
      const onHistoryExact = (posted: any) => {
        if (typeof posted.replayOp !== 'number') return
        asReplay(posted, () => replayPair(posted), delayedAck)
      }
      // Task 733 / 036 step H: a late reply lands after the webview's restore slices instead of before.
      const delayedAck = () => {
        const reply = {
          command: 'replay-ack',
          epoch: state.epoch,
          replayOp: replayApplied,
          acceptedSequence: lastSequence,
        }
        if (setup.exactReplyDelayMs > 0)
          setTimeout(() => answer(reply), setup.exactReplyDelayMs)
        else answer(reply)
      }
      const replayPair = (posted: any): boolean => {
        state.historyOps++
        const pair = pairs.find((p) => p.requestId === posted.requestId)
        const start = posted.kind === 'undo' ? pair?.after : pair?.before
        const end = posted.kind === 'undo' ? pair?.before : pair?.after
        if (
          setup.refuseExact ||
          typeof posted.sequence !== 'number' ||
          start === undefined ||
          end === undefined ||
          start !== state.text
        ) {
          refusing = posted.replayOp
          resync()
          return false
        }
        state.text = end
        state.exactReplays++
        outcome = 'replayed'
        return true
      }

      // Task 733 / 036 (B0): the status of one operation of the named epoch (fix design 3.2).
      const endedOf = (epoch: number) =>
        ended !== undefined && ended.epoch === epoch ? ended : undefined
      const endedStatus = (posted: any): string => {
        const own = endedOf(posted.epoch)
        if (posted.replayOp <= (own?.applied ?? 0)) return 'applied'
        return own?.refused === posted.replayOp ? 'refused' : 'ended'
      }
      const replayStatusOf = (posted: any): string => {
        if (posted.epoch > state.epoch) return 'unknown'
        if (posted.epoch < state.epoch) return endedStatus(posted)
        if (posted.replayOp <= replayApplied) return 'applied'
        return reserved.has(posted.replayOp) ? 'reserved' : 'unknown'
      }
      const onReplayQuery = (posted: any) => {
        const own = ended?.epoch === posted.epoch && posted.epoch < state.epoch
        const status = replayStatusOf(posted)
        if (status === 'unknown') state.unknownStatuses++
        answer({
          command: 'replay-status',
          epoch: posted.epoch,
          replayOp: posted.replayOp,
          state: status,
          applied: own ? ended?.applied : replayApplied,
          acceptedSequence: own ? ended?.accepted : lastSequence,
        })
      }

      const handlers: Record<string, (posted: any) => void> = {
        'flush-for-save-done': (posted) => {
          state.flushReplies.push({
            requestId: String(posted.requestId),
            at: performance.now(),
            text: state.text,
          })
        },
        'history-exact': onHistoryExact,
        'replay-abandon': (posted: any) => {
          if (posted.epoch === state.epoch) resync()
        },
        'replay-reserve': (posted: any) => {
          if (posted.epoch !== state.epoch || posted.replayOp <= replayApplied)
            return
          replayCarried = true
          reserved.add(posted.replayOp)
          state.lastReplayOp = Math.max(state.lastReplayOp, posted.replayOp)
        },
        'replay-query': onReplayQuery,
        'host-state-query': (posted: any) =>
          answer({
            command: 'host-state',
            requestId: posted.requestId,
            epoch: state.epoch,
            revision: 0,
            content: state.text,
          }),
        ready: onReady,
        edit: onEdit,
        'edit-delta': onDelta,
        'history-delta': onDelta,
        'history-transition': onTransition,
      }
      const receive = (posted: any) => {
        const kind = typeof posted?.command === 'string' ? posted.command : '?'
        const at = performance.now()
        state.kinds.push(kind)
        if (kind === 'history-exact' && typeof posted.sequence === 'number')
          state.exactPosts.push({ sequence: posted.sequence, at })
        outcome = 'recorded'
        if (Object.hasOwn(handlers, kind)) handlers[kind](posted)
        state.lastOpAt = at
        state.ops.push({ kind, at, ms: performance.now() - at, outcome })
      }

      ;(window as any).acquireVsCodeApi = () => ({
        postMessage: receive,
        getState: () => undefined,
        setState: () => undefined,
      })
    },
    {
      content: init.content,
      options: init.options ?? {},
      holdRebind: init.holdRebind === true,
      refuseExact: init.refuseExact === true,
      exactReplyDelayMs: init.exactReplyDelayMs ?? 0,
    },
  )
}

/** A copy of the stub's state. */
export function hostStubState(page: Page): Promise<HostStubState> {
  return page.evaluate(() => {
    const state = (window as any).__vmdeHostStub as HostStubState | undefined
    if (!state) throw new Error('host stub not installed')
    return {
      ...state,
      kinds: [...state.kinds],
      ops: [...state.ops],
      flushRequests: [...state.flushRequests],
      flushRequestTimes: [...state.flushRequestTimes],
      flushReplies: [...state.flushReplies],
      exactPosts: [...state.exactPosts],
    }
  })
}

/** Task 733 / 036 step H: a copy of the stub's state without the host text (no text crosses the page). */
export function hostStubCounters(page: Page): Promise<HostStubCounters> {
  return page.evaluate(() => {
    const state = (window as any).__vmdeHostStub as HostStubState | undefined
    if (!state) throw new Error('host stub not installed')
    const { text: _text, flushReplies, ...rest } = state
    // No text crosses the page: the reply texts stay in the stub.
    const counters = {
      ...rest,
      flushReplies: flushReplies.map((r) => ({ ...r, text: '' })),
    }
    return {
      ...counters,
      kinds: [...state.kinds],
      ops: [...state.ops],
      exactPosts: [...state.exactPosts],
    }
  })
}

/** Task 733 / 036 D-18: sends the host's `flush-for-save` request with `requestId`. */
export function requestFlush(page: Page, requestId: string): Promise<void> {
  return page.evaluate((id) => {
    ;(window as any).__vmdeHostStubFlush(id)
  }, requestId)
}

/** Task 733 / 022: sends the rebind answer that `holdRebind` held; false when none is held. */
export function releaseRebind(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as any).__vmdeHostStubReleaseRebind() as boolean,
  )
}
