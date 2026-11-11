import {
  type MovableBlock,
  scanMovableBlocks,
} from '../../../src/shared/block-move'
import type { HostMessage } from '../../../src/shared/protocol'
import { installModelSync } from './model-structure'
import {
  createTextModel,
  type SyncResult,
  type TextModel,
  type Unit,
} from './text-model'
import { createUnitDom, type UnitDomControl } from './unit-dom'
import {
  createUnitSchedule,
  installPreTouchListeners,
  type UnitSchedule,
} from './unit-schedule'
import type { UnitLute } from './unit-lute'

// Task 733 (004-C): one text model per Vditor instance, kept beside the edit-sync controller. It
// builds the model from the host text once the complete IR edit DOM exists, tracks the DOM through
// the unit adapter, and, in this task, only shadows each whole-text publication: it predicts the
// bytes and compares them with the host's `rebind` answer. Nothing it computes is posted yet.

type U = Unit<HTMLElement>
type RebindMessage = Extract<HostMessage, { command: 'rebind' }>
type OffReason = NonNullable<TextModel<HTMLElement>['offReason']>
type FallbackReason = Extract<SyncResult, { kind: 'fallback' }>['reason']

/** The part of an outcome message (block action, outline move) the session reads. */
interface HostWriteOutcome {
  status: string
  content?: string
  epoch?: number
}

/** Text size up to which a prediction mismatch counts as a model error (agreement subset). */
const AGREEMENT_MAX_CHARS = 100_000

export interface ModelSessionDeps {
  win: Window
  /** The IR edit root, or null while it does not exist. */
  getRoot(): HTMLElement | null
  /** The live (wrapped) Lute of the editor, or null. */
  getLute(): UnitLute | null
  getMode(): string | null
  /**
   * The Preview pane is showing over the IR editor (Vditor's current mode stays `ir`). The model does
   * no work then: no proof slices, no audit.
   */
  isPreviewShowing(): boolean
  /** A large document is still streaming in: the DOM is partial. */
  isStreaming(): boolean
  isComposing(): boolean
  /** End-to-end runs publish the shadow stats and classify each answer. */
  e2e: boolean
  countFallbackPublication(win: Window): void
  requestAnimationFrame(callback: () => void): number
  cancelAnimationFrame(handle: number): void
  now(): number
  setTimeout(callback: () => void, ms: number): number
  clearTimeout(handle: number): void
  inViewport(el: HTMLElement): boolean
}

export interface ModelSession {
  /**
   * A host text arrived (init, update, deferred update): hold it, end any awaiting, rebuild.
   * `sameDom`: the DOM is the one the model describes (an update whose text the editor already
   * shows), so the model rebinds and keeps its proofs instead of building again.
   */
  onHostText(text: string, epoch: number, options?: { sameDom?: boolean }): void
  onRebind(message: RebindMessage): void
  /** D2: a block action or an outline move wrote the document and announced a new epoch. */
  onHostWriteOutcome(message: HostWriteOutcome): void
  /**
   * D3: the host refused an exact edit. The awaiting state ends only when the refused edit is the
   * awaited one (its `requestId` names it), or when the refusal names no request.
   */
  onExactRefused(requestId?: string): void
  /** Rule 4.1: a request that makes the host write by itself (block action, outline move, checkbox) was posted. */
  onHostWriteRequested(): void
  /** A host-write request ended without an `update` to follow (refused, stale, failed). */
  onHostWriteEnded(): void
  /** The host is saving: one full audit pass follows in the idle slices (action 6). */
  onSave(): void
  /** Turn the model off for a reason (a failed shadow call must not touch the post that went out). */
  turnOff(reason: OffReason): void
  onModeChange(mode: string | null): void
  /** The complete IR edit DOM is mounted (not streaming, not deferred). */
  onEditDomComplete(): void
  /**
   * Called at each whole-text publication. Returns `{ rebind: true }` when the host should answer
   * with its bytes. `options.predict === false`: the exact post, which is never shadowed.
   */
  beforeWholeTextPost(
    sequence: number,
    options?: { predict: boolean; requestId?: string },
  ): { rebind: true } | undefined
  /**
   * An Undo or Redo transition changed the document by the editor's history engine. The host is told
   * without a sequence (a sequenced transition that the host declines is answered by an `update` that
   * overwrites the Undo, see the round-1 note in the task record), so the model cannot learn the new
   * bytes from an answer: it stops trusting its text until the next `rebind` or `update`, and the next
   * whole-text publication asks for the host bytes without a prediction.
   */
  onHistoryTransition(): void
  confirmedUnits(): readonly U[] | undefined
  /** The model text and epoch when the model is live, clean and confirmed (live-configuration rebuild). */
  confirmedSnapshot(): { text: string; epoch: number } | undefined
  onUnitsChanged(listener: () => void): () => void
  dispose(): void
}

interface Prediction {
  sequence: number
  text: string
  /** The publication changed exactly one unit (recorded at prediction). */
  oneUnit: boolean
}

/** Compare counters of the end-to-end shadow (kinds and counts only: SR-5). */
interface ShadowCounters {
  compared: number
  equal: number
  expectedDifference: number
  mismatch: number
}

const normalizeEol = (text: string): string => text.replace(/\r\n?/gu, '\n')

const stripTrailingNewlines = (text: string): string =>
  text.replace(/\n+$/u, '')

/**
 * Whether the document is in the subset where a prediction must equal the host bytes. The gaps are
 * read from the PREDICTED text, the model's own bytes: the host's answer is Lute's output and is
 * canonical by construction, so it cannot show that the document had a gap the model keeps and the
 * host normalizes (two blank lines between blocks).
 */
function inAgreementSubset(
  predicted: string,
  content: string,
  oneUnit: boolean,
): boolean {
  if (!oneUnit || content.length > AGREEMENT_MAX_CHARS) return false
  const blocks: MovableBlock[] = scanMovableBlocks(predicted)
  // YAML front matter is outside the subset: the host takes Lute's serialization of that block,
  // which joins it to the next block with one newline, so the first publication of any edit differs
  // from the model's bytes (which keep the document's blank line) at that junction. Observed on
  // `tableHeavyMarkdown(1)`; the publications after the first agree.
  if (blocks.some((block) => block.kind === 'front-matter')) return false
  for (let i = 1; i < blocks.length; i += 1) {
    const gap = predicted.slice(blocks[i - 1].end, blocks[i].start)
    const tight =
      blocks[i - 1].kind === 'list-item' &&
      blocks[i].kind === 'list-item' &&
      blocks[i - 1].listRun === blocks[i].listRun
    // A list is tight (one newline between items); every other gap is one blank line.
    if (gap !== (tight ? '\n' : '\n\n')) return false
  }
  return true
}

function countChanged(units: readonly U[], sequence: number): number {
  let count = 0
  const walk = (unit: U): void => {
    if (unit.children.length === 0) {
      if (unit.changedAt === sequence) count += 1
      return
    }
    for (const child of unit.children) walk(child)
  }
  for (const unit of units) walk(unit)
  return count
}

function countDirty(units: readonly U[]): number {
  let count = 0
  const walk = (unit: U): void => {
    if (unit.dirty) count += 1
    for (const child of unit.children) walk(child)
  }
  for (const unit of units) walk(unit)
  return count
}

export function createModelSession(deps: ModelSessionDeps): ModelSession {
  // `sync()` answers `sync-error` until the structure windows are installed (model-structure.ts).
  installModelSync()
  const { win } = deps
  let host: { text: string; epoch: number } | undefined
  let domComplete = false
  let model: TextModel<HTMLElement> | undefined
  let dom: UnitDomControl | undefined
  let modelLute: UnitLute | undefined
  let schedule: UnitSchedule | undefined
  let removeListeners: (() => void) | undefined
  let offReason: OffReason = 'not-mounted'
  /** The model text was confirmed by the last `update` or `rebind` (an exact answer does not). */
  let confirmed = false
  /** Sequence of the latest whole-text edit or transition whose answer is outstanding. */
  let awaited: number | undefined
  /** The exact post that carries `requestId` was posted with this sequence (until answered). */
  const exactSequences = new Map<string, number>()
  /** A host-write request is outstanding: it ends with its outcome message or the next `update`. */
  let awaitingWrite = false
  /** An Undo or Redo changed the DOM and no answer brought the new bytes: the model text is not trusted. */
  let stale = false
  let prediction: Prediction | undefined
  let preTouchFallback = false
  let buildFrame: number | undefined
  const listeners = new Set<() => void>()
  const fallbacks: Partial<Record<FallbackReason, number>> = {}
  const shadow: ShadowCounters = {
    compared: 0,
    equal: 0,
    expectedDifference: 0,
    mismatch: 0,
  }

  const notify = (): void => {
    for (const listener of Array.from(listeners)) listener()
  }

  const teardown = (): void => {
    removeListeners?.()
    removeListeners = undefined
    schedule?.stop()
    schedule = undefined
    dom?.detach()
    dom = undefined
    model = undefined
    prediction = undefined
    preTouchFallback = false
    exactSequences.clear()
    stale = false
  }

  const cancelBuild = (): void => {
    if (buildFrame !== undefined) deps.cancelAnimationFrame(buildFrame)
    buildFrame = undefined
  }

  /** Builds the model from the held host text if every precondition holds; otherwise stays off. */
  const attempt = (): void => {
    cancelBuild()
    teardown()
    confirmed = false
    if (deps.getMode() !== 'ir') {
      offReason = 'mode'
      return
    }
    const root = deps.getRoot()
    const lute = deps.getLute()
    if (!host || !domComplete || deps.isStreaming() || !root || !lute) {
      offReason = 'not-mounted'
      return
    }
    // Bound at build: the model's own Lute work (proofs, audit, shadow sync) calls the functions the
    // editor has now, so a later wrapper put around the editor's Lute calls (an end-to-end spec
    // counting edit-path calls, an instrument) sees the editor's calls and not this shadow work, which
    // the shadow stats report instead. Every production wrapper is already installed by now.
    const boundLute: UnitLute = {
      VditorIRDOM2Md: lute.VditorIRDOM2Md.bind(lute),
      Md2VditorIRDOM: lute.Md2VditorIRDOM.bind(lute),
    }
    modelLute = boundLute
    const unitDom = createUnitDom(root, boundLute)
    const built = createTextModel(unitDom, scanMovableBlocks)
    built.build(host.text)
    model = built
    if (built.state !== 'live') {
      offReason = built.offReason ?? 'not-mounted'
      return
    }
    dom = unitDom
    unitDom.attach(built)
    const unitSchedule = createUnitSchedule({
      model: built,
      root,
      serialize: (kind, members) => unitDom.serialize(kind, members),
      htmlLength: (unit) =>
        unit.members.reduce((sum, el) => sum + el.outerHTML.length, 0),
      inViewport: (unit) => (unit.el ? deps.inViewport(unit.el) : false),
      isActive: () =>
        deps.getMode() === 'ir' &&
        !deps.isPreviewShowing() &&
        model?.state === 'live',
      drain: () => unitDom.drain(),
      requestAnimationFrame: (cb) => deps.requestAnimationFrame(cb),
      cancelAnimationFrame: (handle) => deps.cancelAnimationFrame(handle),
      now: () => deps.now(),
      setTimeout: (cb, ms) => deps.setTimeout(cb, ms),
      clearTimeout: (handle) => deps.clearTimeout(handle),
    })
    schedule = unitSchedule
    removeListeners = installPreTouchListeners({
      root,
      schedule: unitSchedule,
      isComposing: () => deps.isComposing(),
      // The next whole-text publication is a fallback (reason in the schedule's stats).
      onFallback: () => {
        preTouchFallback = true
      },
    })
    confirmed = true
    unitSchedule.start()
    notify()
  }

  /** A `setValue` rebuild finishes in later microtasks: build on the next animation frame (OQ-5). */
  const buildSoon = (): void => {
    cancelBuild()
    teardown()
    confirmed = false
    offReason = 'not-mounted'
    buildFrame = deps.requestAnimationFrame(() => {
      buildFrame = undefined
      attempt()
    })
  }

  const countFallback = (reason: FallbackReason): void => {
    fallbacks[reason] = (fallbacks[reason] ?? 0) + 1
    deps.countFallbackPublication(win)
  }

  const live = (): boolean => model?.state === 'live'

  /** Classify an answer against its prediction (end-to-end runs only; shared rules 6.5). */
  const classify = (content: string): void => {
    const predicted = prediction
    if (!predicted) return
    shadow.compared += 1
    if (predicted.text === content) {
      shadow.equal += 1
      return
    }
    const lute = modelLute ?? null
    const sameCanon =
      lute !== null &&
      stripTrailingNewlines(
        lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(predicted.text)),
      ) ===
        stripTrailingNewlines(lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(content)))
    if (
      sameCanon &&
      !inAgreementSubset(predicted.text, content, predicted.oneUnit)
    )
      shadow.expectedDifference += 1
    else shadow.mismatch += 1
  }

  const finishAnswer = (content: string, epoch: number): void => {
    host = { text: content, epoch }
    stale = false
    if (model?.state === 'live') {
      model.rebind(content)
      if (model.state === 'live') {
        confirmed = true
        schedule?.restart()
        notify()
        return
      }
      offReason = model.offReason ?? 'pairing-failed'
      return
    }
    // Off (or never built) with the complete IR DOM mounted: a host text builds it.
    if (domComplete) attempt()
  }

  const publishStats = (): Record<string, unknown> => {
    dom?.drain()
    const treeStats = schedule?.stats()
    return {
      state: model?.state ?? 'off',
      offReason: model ? model.offReason : offReason,
      units: treeStats?.units ?? 0,
      proven: treeStats?.proven ?? 0,
      opaque: treeStats?.opaque ?? 0,
      dirtyNow: model ? countDirty(model.units) : 0,
      ...shadow,
      fallbacks: { ...fallbacks },
      auditMismatch: treeStats?.auditMismatch ?? 0,
    }
  }

  if (deps.e2e) {
    Object.defineProperty(win, '__vmdeModelShadowStats', {
      configurable: true,
      get: publishStats,
    })
    Object.defineProperty(win, '__vmdeModelShadowAudit', {
      configurable: true,
      // The mismatches found by the pass this call ran, not the running total.
      value: (): Promise<number> => {
        const before = schedule?.stats().auditMismatch ?? 0
        schedule?.requestAudit(true)
        return Promise.resolve((schedule?.stats().auditMismatch ?? 0) - before)
      },
    })
  }

  const publicationBase = (sequence: number): void => {
    awaited = sequence
    confirmed = false
    prediction = undefined
  }

  /** A whole-text publication that is not predicted: the model clears its flags and awaits the host bytes. */
  const unshadowedPost = (
    current: TextModel<HTMLElement>,
    sequence: number,
  ): { rebind: true } => {
    if (preTouchFallback)
      countFallback(schedule?.lastFallbackReason() ?? 'unproven-selection')
    preTouchFallback = false
    current.markPublishedWhole()
    publicationBase(sequence)
    schedule?.restart()
    return { rebind: true }
  }

  const session: ModelSession = {
    onHostText(text, epoch, options) {
      host = { text: normalizeEol(text), epoch }
      awaited = undefined
      awaitingWrite = false
      stale = false
      exactSequences.clear()
      prediction = undefined
      if (options?.sameDom && model?.state === 'live') {
        // The DOM is unchanged: the text arrives as a rebind, so no proof is lost.
        finishAnswer(host.text, epoch)
        return
      }
      confirmed = false
      // The DOM is about to be (or was) rebuilt by `setValue`; with no complete edit DOM there is
      // nothing to build yet and `onEditDomComplete()` will.
      if (domComplete) buildSoon()
    },
    onRebind(message) {
      const content = normalizeEol(message.content)
      const matched =
        message.editSequence !== undefined && message.editSequence === awaited
      // A host-originated write names no edit; only a newer epoch applies. An older answer is ignored.
      const hostOwn =
        message.editSequence === undefined &&
        message.epoch > (host?.epoch ?? Number.NEGATIVE_INFINITY)
      if (!matched && !hostOwn) return
      if (matched) {
        if (deps.e2e && prediction?.sequence === message.editSequence)
          classify(content)
        awaited = undefined
        prediction = undefined
      }
      finishAnswer(content, message.epoch)
    },
    onHostWriteOutcome(message) {
      awaitingWrite = false
      if (message.status !== 'applied' || message.epoch === undefined) return
      awaited = undefined
      prediction = undefined
      if (typeof message.content !== 'string') {
        // The new text is unknown: off until the next host text.
        host = undefined
        teardown()
        confirmed = false
        offReason = 'not-mounted'
        return
      }
      host = { text: normalizeEol(message.content), epoch: message.epoch }
      if (domComplete) buildSoon()
    },
    onExactRefused(requestId) {
      const refused =
        requestId === undefined ? undefined : exactSequences.get(requestId)
      // A refusal for an earlier exact post must not cancel the wait for a later answer.
      if (requestId !== undefined && refused !== awaited) {
        exactSequences.delete(requestId)
        return
      }
      if (requestId !== undefined) exactSequences.delete(requestId)
      awaited = undefined
      prediction = undefined
    },
    onHostWriteRequested() {
      if (!live()) return
      dom?.drain()
      awaitingWrite = true
    },
    onHostWriteEnded() {
      awaitingWrite = false
    },
    onSave() {
      schedule?.requestAudit(false)
    },
    turnOff(reason) {
      cancelBuild()
      teardown()
      host = undefined
      confirmed = false
      awaited = undefined
      awaitingWrite = false
      offReason = reason
    },
    onModeChange(mode) {
      if (mode === 'ir') return
      host = undefined
      cancelBuild()
      teardown()
      confirmed = false
      awaited = undefined
      awaitingWrite = false
      offReason = 'mode'
    },
    onEditDomComplete() {
      domComplete = true
      if (host) attempt()
    },
    beforeWholeTextPost(sequence, options) {
      if (!live() || !model) return undefined
      if (deps.getMode() !== 'ir') {
        session.onModeChange(deps.getMode())
        return undefined
      }
      dom?.drain()
      if (options?.requestId !== undefined)
        exactSequences.set(options.requestId, sequence)
      // Not shadowed: a composition, the exact post, a publication the pre-touch proof refused.
      if (
        deps.isComposing() ||
        options?.predict === false ||
        preTouchFallback ||
        stale
      )
        return unshadowedPost(model, sequence)
      const result = model.sync(sequence)
      publicationBase(sequence)
      if (result.kind === 'fallback') {
        countFallback(result.reason)
        model.markPublishedWhole()
      } else {
        prediction = {
          sequence,
          text: model.text,
          // Only the end-to-end classifier reads this; it walks every unit, so production skips it.
          oneUnit: deps.e2e && countChanged(model.units, sequence) === 1,
        }
      }
      if (model.state === 'live') schedule?.restart()
      notify()
      return { rebind: true }
    },
    onHistoryTransition() {
      if (!live() || !model || deps.getMode() !== 'ir') return
      dom?.drain()
      stale = true
      confirmed = false
      prediction = undefined
    },
    confirmedUnits() {
      if (
        !model ||
        !live() ||
        awaited !== undefined ||
        awaitingWrite ||
        stale ||
        !confirmed
      )
        return undefined
      dom?.drain()
      return model.hasDirty() ? undefined : model.units
    },
    confirmedSnapshot() {
      const units = session.confirmedUnits()
      return units && model && host
        ? { text: model.text, epoch: host.epoch }
        : undefined
    },
    onUnitsChanged(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      cancelBuild()
      teardown()
      listeners.clear()
      if (deps.e2e) {
        delete (win as unknown as Record<string, unknown>)
          .__vmdeModelShadowStats
        delete (win as unknown as Record<string, unknown>)
          .__vmdeModelShadowAudit
      }
    },
  }
  return session
}
