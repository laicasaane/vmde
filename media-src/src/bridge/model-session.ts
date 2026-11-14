import {
  type MovableBlock,
  scanMovableBlocks,
} from '../../../src/shared/block-move'
import type { HostMessage } from '../../../src/shared/protocol'
import type {
  DeltaFallbackReason,
  DeltaSessionPort,
  PrepareResult,
} from './delta-sync'
import { installModelSync } from './model-structure'
import type { TextChange } from './change-set'
import {
  type ApplyFallbackReason,
  createTextModel,
  type HostUnit,
  type SyncResult,
  type TextModel,
  type Unit,
} from './text-model'
import { createUnitDom } from './unit-dom'
import {
  createUnitSchedule,
  installPreTouchListeners,
  type UnitSchedule,
} from './unit-schedule'
import type {
  HistoryModelPort,
  LiveUnit,
  UnitLines,
  UnitsChange,
} from '../util/unit-changes'
import { createUnitCapture } from './unit-capture'
import type { UnitLute } from './unit-lute'

// Task 733 (004-C): one text model per Vditor instance, kept beside the edit-sync controller. It
// builds the model from the host text once the complete IR edit DOM exists, tracks the DOM through
// the unit adapter, and, in this task, only shadows each whole-text publication: it predicts the
// bytes and compares them with the host's `rebind` answer. Nothing it computes is posted yet.

type U = Unit<HTMLElement>
type RebindMessage = Extract<HostMessage, { command: 'rebind' }>
type OffReason = NonNullable<TextModel<HTMLElement>['offReason']>

/** Who asks for an apply (shared rules 3.7): an exact action, a host update, a refusal rollback. */
type ApplyOrigin = 'exact' | 'host' | 'rollback'
export type ApplyOutcome =
  | { kind: 'applied' }
  | { kind: 'fallback'; reason: ApplyFallbackReason }

const APPLIED: ApplyOutcome = { kind: 'applied' }
const applyFallback = (reason: ApplyFallbackReason): ApplyOutcome => ({
  kind: 'fallback',
  reason,
})
const APPLY_OFF = applyFallback('model-off')

/** The part of an outcome message (block action, outline move) the session reads. */
interface HostWriteOutcome {
  status: string
  content?: string
  epoch?: number
}

/** Quiet time after the last delta before the proof queues are rebuilt. */
const RESTART_QUIET_MS = 250

/**
 * A (start, line) pair at or before `offset`, from the top-level units (ascending by start): the text
 * before `offset` is the same before and after the sync, so the unit's line is valid for both. This
 * keeps the position scan of a delta from starting at offset 0.
 */
function lineHint(
  model: TextModel<HTMLElement>,
  offset: number,
): { offset: number; line: number } | undefined {
  // The deepest unit at or before `offset` (table, row, cell), so a cell edit near the end of a
  // large table does not scan the table from its first line (m5).
  let units: readonly U[] = model.units
  let found: U | undefined
  while (units.length > 0) {
    let low = 0
    let high = units.length - 1
    let level: U | undefined
    while (low <= high) {
      const mid = (low + high) >> 1
      if (units[mid].start <= offset) {
        level = units[mid]
        low = mid + 1
      } else high = mid - 1
    }
    if (!level) break
    found = level
    units = level.children
  }
  return found ? { offset: found.start, line: found.startLine } : undefined
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
  /**
   * Task 733 / 010: writes `changes` (against the model text) into the IR DOM unit by unit and commits
   * them to the model; no post, no build, same epoch. A fallback leaves the DOM unchanged.
   */
  applyText(changes: readonly TextChange[], origin: ApplyOrigin): ApplyOutcome
  /**
   * Task 733 / 010 (DR2): typing that a `prepareDelta` took into the model was not published: the model
   * text goes back to `text` (same DOM) and the next publication or flush posts the whole text, which
   * carries the typing.
   */
  reopenTyping(text: string): void
  /** Task 733 / 010 (Q-80): a host update was applied by units: take its text and epoch, keep every unit (no rescan). */
  adoptHostEpoch(text: string, epoch: number): void
  /** Task 733 / 010: a caller's setValue rebuilt the DOM for `text`: build on the next frame, same epoch and sequence. */
  rebuildAfterExact(text: string): void
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
  /**
   * Fires at build, rebind, a sync with changes and, merged into one change per animation frame, for
   * the batches the observer marks. A listener that takes no argument stays valid.
   */
  onUnitsChanged(listener: (change: UnitsChange) => void): () => void
  /** Task 733 (007-B): the model side of the delta publisher (bridge/delta-sync.ts). */
  deltaPort(): DeltaSessionPort
  /** Task 733 (task 004): the capture and restore of unit windows for the unit history engine. */
  historyPort(): HistoryModelPort
  /** The model is live in IR, so a publication goes through the delta publisher. */
  canPublishDelta(): boolean
  /** Live, trusted, confirmed and not awaiting: the model text is the exact host text plus typing. */
  ownsText(): boolean
  /**
   * A whole-text edit that asked for a `rebind` was posted by the fallback publisher: record the
   * awaited sequence only (the shadow work is not repeated), and the model awaits the answer.
   */
  onWholeTextPublished(sequence: number, options?: { requestId?: string }): void
  /** A fallback publication of the delta path: counted by reason, never with document content. */
  recordFallback(reason: DeltaFallbackReason): void
  /** The Task 390 explicit-edit mark: the unit under the caret writes its canon on the next sync. */
  markExplicitAtCaret(): void
  /**
   * The nearest ancestor element of `node` (itself included) that is a leaf unit's element, as a
   * `LiveUnit`; `undefined` when the model is not live. Allocates only the returned object.
   */
  liveUnitOf(node: Node): LiveUnit | undefined
  /** The model is live (O(1), no allocation). */
  isLive(): boolean
  /** Top-level units (lists expanded to items) of the live model, dirty ones included; `undefined` when not live. */
  liveUnits(): readonly LiveUnit[] | undefined
  /** Line ranges of the top-level confirmed units; `undefined` when `confirmedUnits()` is. No Lute call. */
  confirmedLines(): readonly UnitLines[] | undefined
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

/** Length and FNV-1a hash (32 bits, over UTF-16 code units) of a text: an end-to-end comparison without the text. */
function textDigest(text: string): { length: number; hash: number } {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return { length: text.length, hash: hash >>> 0 }
}

function resetChangedAt(units: readonly U[]): void {
  for (const unit of units) {
    unit.changedAt = 0
    resetChangedAt(unit.children)
  }
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

/** The ancestor of `el` (or `el`) that is a child of `root`. */
function rootChild(el: HTMLElement, root: HTMLElement | null): HTMLElement {
  let top = el
  while (top.parentElement && top.parentElement !== root)
    top = top.parentElement
  return top
}

/** A unit as a `LiveUnit`; `top` is the table or list of a cell or item. */
function toLiveUnit(
  unit: Unit<HTMLElement>,
  root: HTMLElement | null,
): LiveUnit {
  const first = (unit.el ?? unit.members[0]) as HTMLElement
  const nested = unit.kind === 'cell' || unit.kind === 'list-item'
  const top = nested ? rootChild(first, root) : first
  return {
    el: first,
    members: unit.members,
    kind: unit.kind as LiveUnit['kind'],
    top,
  }
}

/** Newlines in `text` between `from` and `to`, without copying the range. */
function newlinesBetween(text: string, from: number, to: number): number {
  let count = 0
  let at = text.indexOf('\n', from)
  while (at !== -1 && at < to) {
    count += 1
    at = text.indexOf('\n', at + 1)
  }
  return count
}

/** Adds `batch` to `target`, creating the set on the first batch of a frame. */
function mergeBatch<T>(
  target: Set<T> | undefined,
  batch: ReadonlySet<T>,
): Set<T> | undefined {
  if (batch.size === 0) return target
  if (!target) return new Set(batch)
  for (const item of batch) target.add(item)
  return target
}

interface ResolvedBatch {
  whole: boolean
  changed: LiveUnit[]
  structural: HTMLElement[]
}

/** Adds the leaf units to `changed` (once per element) and table-level marks to `structural`; removed units are dropped. */
function resolveUnits(
  units: ReadonlySet<Unit<HTMLElement>> | undefined,
  root: HTMLElement | null,
  changed: LiveUnit[],
  structural: Set<HTMLElement>,
): void {
  const seen = new Set<HTMLElement>()
  for (const unit of units ?? []) {
    const first = unit.el ?? unit.members[0]
    if (!first?.isConnected) continue
    if (unit.kind === 'table' || unit.kind === 'row')
      structural.add(rootChild(first, root))
    else if (!seen.has(first)) {
      seen.add(first)
      changed.push(toLiveUnit(unit, root))
    }
  }
}

/** The batch sets as live units and top-level elements; units whose element left the document are dropped. */
function resolveBatch(
  changedUnits: ReadonlySet<Unit<HTMLElement>> | undefined,
  structure: ReadonlySet<'root' | Unit<HTMLElement>> | undefined,
  root: HTMLElement | null,
): ResolvedBatch {
  let whole = false
  const changed: LiveUnit[] = []
  const structural = new Set<HTMLElement>()
  resolveUnits(changedUnits, root, changed, structural)
  for (const scope of structure ?? []) {
    if (scope === 'root') {
      whole = true
      continue
    }
    const first = scope.el ?? scope.members[0]
    if (first?.isConnected) structural.add(rootChild(first, root))
  }
  changed.sort(documentOrder)
  return { whole, changed, structural: Array.from(structural) }
}

const documentOrder = (a: LiveUnit, b: LiveUnit): number =>
  a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1

/** The leaf unit nearest to `node` below `root`, as a `LiveUnit`; `top` is the table or list of a cell or item. */
function liveUnitFor(
  model: TextModel<HTMLElement>,
  root: HTMLElement | null,
  node: Node,
): LiveUnit | undefined {
  let el: Element | null =
    node instanceof Element ? node : (node.parentElement ?? null)
  while (el && el !== root) {
    const unit = model.unitOf(el as HTMLElement)
    // Row and table units are not leaf units for the unit spin.
    if (unit && unit.kind !== 'row' && unit.kind !== 'table') {
      return toLiveUnit(unit, root)
    }
    el = el.parentElement
  }
  return undefined
}

export function createModelSession(deps: ModelSessionDeps): ModelSession {
  // `sync()` answers `sync-error` until the structure windows are installed (model-structure.ts).
  installModelSync()
  const { win } = deps
  let host: { text: string; epoch: number } | undefined
  let domComplete = false
  let model: TextModel<HTMLElement> | undefined
  let dom: ReturnType<typeof createUnitDom> | undefined
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
  /** Entering IR again: the first IR post asks for the host bytes, and its rebind builds the model (3.6). */
  let modeReentry = false
  let prediction: Prediction | undefined
  let restartTimer: number | undefined
  let preTouchFallback = false
  let buildFrame: number | undefined
  const listeners = new Set<(change: UnitsChange) => void>()
  /** What the observer batches marked since the last emitted change (merged per animation frame). */
  let pendingChanged: Set<Unit<HTMLElement>> | undefined
  let pendingStructure: Set<'root' | Unit<HTMLElement>> | undefined
  let feedFrame: number | undefined
  const fallbacks: Partial<Record<DeltaFallbackReason, number>> = {}
  /** A sync with a sequence may have set `changedAt` since the last reset: only then is a reset walk due (010-R F12). */
  let changedAtSet = false
  const shadow: ShadowCounters = {
    compared: 0,
    equal: 0,
    expectedDifference: 0,
    mismatch: 0,
  }

  const emit = (change: UnitsChange): void => {
    for (const listener of Array.from(listeners)) listener(change)
  }

  const cancelFeedFrame = (): void => {
    if (feedFrame !== undefined) deps.cancelAnimationFrame(feedFrame)
    feedFrame = undefined
    pendingChanged = undefined
    pendingStructure = undefined
  }

  /** Resolves the pending sets against the model as it is now: removed units are dropped. */
  const takePending = (cause: UnitsChange['cause']): UnitsChange => {
    const changedUnits = pendingChanged
    const structure = pendingStructure
    cancelFeedFrame()
    return {
      cause,
      ...resolveBatch(changedUnits, structure, deps.getRoot()),
    }
  }

  const emitWhole = (cause: UnitsChange['cause']): void => {
    cancelFeedFrame()
    emit({ cause, whole: true, changed: [], structural: [] })
  }

  /** The change a whole-text publication's sync reports: a fallback cannot be scoped. */
  const emitPublished = (result: SyncResult): void => {
    if (result.kind !== 'fallback' && result.changes.length > 0) {
      emitSync()
      return
    }
    cancelFeedFrame()
    emit({
      cause: 'sync',
      whole: result.kind === 'fallback',
      changed: [],
      structural: [],
    })
  }

  /** An apply replaced units: the new ones are the changed ones (the apply's own marks are dropped). */
  /** The live units of `elements` that the model lists (rendered members or neighbours). */
  const liveUnitsOf = (
    elements: readonly (Element | null | undefined)[],
    root: HTMLElement | null,
  ): LiveUnit[] => {
    const out: LiveUnit[] = []
    for (const el of elements) {
      const unit = el instanceof HTMLElement ? model?.unitOf(el) : undefined
      if (unit) out.push(toLiveUnit(unit, root))
    }
    return out
  }

  const emitApplied = (
    rendered: readonly HostUnit<HTMLElement>[],
    table: U | undefined,
    neighbours: readonly (Element | null | undefined)[],
  ): void => {
    cancelFeedFrame()
    const root = deps.getRoot()
    // A row apply changed its table (its rows are no top-level units, 010-R F11); a deletion renders
    // nothing, so the units beside the removed ones name the place it changed.
    let changed = table
      ? [toLiveUnit(table, root)]
      : liveUnitsOf(
          rendered.map((listed) => listed.members[0]),
          root,
        )
    if (changed.length === 0) changed = liveUnitsOf(neighbours, root)
    emit({
      cause: 'sync',
      whole: changed.length === 0,
      changed,
      structural: [],
    })
  }

  /** A sync wrote changes: the units marked since the last change are the changed ones. */
  const emitSync = (): void => {
    const change = takePending('sync')
    const known = change.changed.length > 0 || change.structural.length > 0
    // A sync with changes that no batch explains cannot be scoped: consumers run their full pass.
    emit(known || change.whole ? change : { ...change, whole: true })
  }

  /** The frame callback is one closure for the session: a batch allocates no function. */
  const feedFrameDone = (): void => {
    // A cancelled frame (a sync took the pending sets, or the session went off) reports nothing.
    if (feedFrame === undefined) return
    feedFrame = undefined
    // Re-read after the frame: a model that went off meanwhile has nothing to report.
    if (!model || !live()) {
      pendingChanged = undefined
      pendingStructure = undefined
      return
    }
    emit(takePending('mutation'))
  }

  const capture = createUnitCapture({
    model: () => model,
    root: () => deps.getRoot() ?? undefined,
    drain: () => dom?.drain(),
    ready: () => live() && deps.getMode() === 'ir' && !awaitingNow() && !stale,
    // A model that is off observes nothing, so the unit engine could not capture an edit and its Undo
    // would do nothing: the old engine holds the history then (an IR re-entry before the first post's
    // answer, a deferred edit view before its build, a permanent off). Only a rebuild over the same
    // DOM keeps the unit engine: what is pending is held as one step of the next capture (`hold`).
    claimable: () => live() || buildFrame !== undefined,
    vditor: () =>
      (win as unknown as { vditor?: { vditor?: unknown } }).vditor?.vditor,
  })

  /** One mutation change per animation frame, after the last batch of the frame. */
  const onBatch = (
    changed: ReadonlySet<Unit<HTMLElement>>,
    structure: ReadonlySet<'root' | Unit<HTMLElement>>,
  ): void => {
    // The history capture reads the units before a sync can overwrite their HTML.
    capture.onBatch(changed, structure)
    pendingChanged = mergeBatch(pendingChanged, changed)
    pendingStructure = mergeBatch(pendingStructure, structure)
    if (feedFrame !== undefined) return
    feedFrame = deps.requestAnimationFrame(feedFrameDone)
  }

  const teardown = (): void => {
    if (restartTimer !== undefined) deps.clearTimeout(restartTimer)
    restartTimer = undefined
    removeListeners?.()
    removeListeners = undefined
    schedule?.stop()
    schedule = undefined
    dom?.detach()
    dom = undefined
    model = undefined
    cancelFeedFrame()
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
    const unitDom = createUnitDom(root, boundLute, {
      onBatch,
      // The post-render steps of an apply (previews, captions, outline) need the inner editor.
      vditor: () =>
        (win as unknown as { vditor?: { vditor?: unknown } }).vditor?.vditor,
    })
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
    const stopWatching = capture.watch(root)
    const stopPreTouch = installPreTouchListeners({
      root,
      schedule: unitSchedule,
      isComposing: () => deps.isComposing(),
      // The next whole-text publication is a fallback (reason in the schedule's stats).
      onFallback: () => {
        preTouchFallback = true
      },
    })
    removeListeners = () => {
      stopWatching()
      stopPreTouch()
    }
    confirmed = true
    unitSchedule.start()
    emitWhole('build')
  }

  /** A `setValue` rebuild finishes in later microtasks: build on the next animation frame (OQ-5). */
  const buildSoon = (): void => {
    cancelBuild()
    // The same DOM is described by the next model: what is pending stays one step of the next capture.
    capture.hold()
    teardown()
    confirmed = false
    offReason = 'not-mounted'
    buildFrame = deps.requestAnimationFrame(() => {
      buildFrame = undefined
      attempt()
    })
  }

  const countFallback = (reason: DeltaFallbackReason): void => {
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
        emitWhole('rebind')
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
    // The published model text must equal the host document: the spec compares digests of the two,
    // so no document text crosses into the page's counters or logs (SR-5).
    Object.defineProperty(win, '__vmdeModelTextDigest', {
      configurable: true,
      value: (): { length: number; hash: number } | null =>
        model && live() ? textDigest(model.text) : null,
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

  const awaitingNow = (): boolean => awaited !== undefined || awaitingWrite

  /**
   * The proof queues rebuild by walking every unit, so a restart per keystroke costs the document size.
   * Typing restarts them once after a quiet moment instead.
   */
  const restartSoon = (): void => {
    if (restartTimer !== undefined) deps.clearTimeout(restartTimer)
    restartTimer = deps.setTimeout(() => {
      restartTimer = undefined
      schedule?.restart()
    }, RESTART_QUIET_MS)
  }

  const offFallback: PrepareResult = { kind: 'fallback', reason: 'model-off' }

  /** The reasons a publication cannot be a delta before the model is asked: a fallback result, else undefined. */
  const deltaGate = (): PrepareResult | undefined => {
    if (!model || !live()) return offFallback
    if (deps.getMode() !== 'ir') {
      session.onModeChange(deps.getMode())
      return offFallback
    }
    dom?.drain()
    if (stale) return { kind: 'fallback', reason: 'history-transition' }
    if (preTouchFallback) {
      return {
        kind: 'fallback',
        reason: schedule?.lastFallbackReason() ?? 'unproven-selection',
      }
    }
    return undefined
  }

  /** Model off after leaving IR: the first IR post asks for the host bytes (3.6). */
  const reentryPost = (
    sequence: number,
    options?: { requestId?: string },
  ): { rebind: true } | undefined => {
    if (!modeReentry || deps.getMode() !== 'ir' || !domComplete)
      return undefined
    modeReentry = false
    awaited = sequence
    if (options?.requestId !== undefined)
      exactSequences.set(options.requestId, sequence)
    return { rebind: true }
  }

  const port: DeltaSessionPort = {
    prepareDelta(sequence): PrepareResult {
      const refused = deltaGate()
      if (refused || !model) return refused ?? offFallback
      const before = model.text
      const result = model.sync(sequence)
      changedAtSet = true
      if (result.kind === 'fallback')
        return { kind: 'fallback', reason: result.reason }
      if (result.changes.length === 0 || model.state !== 'live')
        return { kind: 'changes', before, changes: result.changes }
      // 3.7: the host holds these bytes after the delta, or resynchronizes (P2).
      confirmed = true
      restartSoon()
      emitSync()
      return {
        kind: 'changes',
        before,
        changes: result.changes,
        hint: lineHint(model, result.changes[0].from),
      }
    },
    epoch: () => (live() && host ? host.epoch : undefined),
    awaiting: awaitingNow,
    hasDirty() {
      if (!model || !live()) return false
      dom?.drain()
      return model.hasDirty()
    },
    modelText: () => (live() && model ? model.text : undefined),
    rebind(text) {
      if (!model || !live()) return
      model.rebind(text)
      if (host) host = { text, epoch: host.epoch }
      if (model.state === 'live') {
        schedule?.restart()
        emitWhole('rebind')
      } else offReason = model.offReason ?? 'pairing-failed'
    },
    markPublishedWhole() {
      if (!model || !live()) return
      preTouchFallback = false
      model.markPublishedWhole()
      schedule?.restart()
    },
    clearForms(keep) {
      if (model && live()) model.clearForms(keep)
    },
  }

  const session: ModelSession = {
    onHostText(text, epoch, options) {
      // The answer to a host write this webview asked for (a Preview checkbox toggle) arrives as a
      // host text: read before the reset below.
      const answersWrite = awaitingWrite && live()
      host = { text: normalizeEol(text), epoch }
      modeReentry = false
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
      // The text behind every capture so far is gone, unless this answers a requested host write
      // whose rewrite a checkpoint already captured: that capture matches the DOM and the text, so
      // it stays restorable, as after an outline move (`onHostWriteOutcome`). A rewrite left pending
      // is an update no checkpoint took (an outside change in place of the answer).
      if (!answersWrite || capture.port.pending()) capture.invalidate()
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
      const newEpoch = hostOwn
      finishAnswer(content, message.epoch)
      // 3.5 A: a host write that starts an epoch restarts the delta counter, so no unit keeps a
      // `changedAt` of the epoch that ended.
      if (newEpoch && model?.state === 'live') {
        resetChangedAt(model.units)
        changedAtSet = false
      }
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
      // The host did not write the refused bytes (or names no request, Q-15 D3): the model keeps text the
      // host does not hold, so it is untrusted until a whole-text publication brings the host bytes.
      if (live()) {
        stale = true
        confirmed = false
      }
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the apply's gates, plan, render, kind check and commit are one transaction (handoff 2.4)
    applyText(changes, origin) {
      if (!model || !dom || !live() || deps.getMode() !== 'ir') return APPLY_OFF
      if (origin === 'exact' && !session.ownsText()) return APPLY_OFF
      // A composition owns the DOM under the caret.
      if (deps.isComposing()) return applyFallback('dirty-overlap')
      const current = model
      const unitDom = dom
      unitDom.drain()
      const planned = current.planApply(changes)
      if (planned.kind === 'fallback') return planned
      const { plan } = planned
      const rows = plan.tableRows?.[0]
      const replace = rows
        ? rows.rows.map(
            (r) =>
              rows.table.children[r].members[0].parentElement as HTMLElement,
          )
        : plan.removed.flatMap((unit) => unit.members)
      const neighbours = [
        replace[0]?.previousElementSibling,
        replace[replace.length - 1]?.nextElementSibling,
      ]
      // The history capture snapshots the scopes while the replaced elements are still in place: a
      // list run after the render has lost its items' list, and an Undo could not find it (DR1).
      const scopes = new Set<'root' | U>()
      if (rows) scopes.add(rows.table)
      else {
        scopes.add('root')
        for (const unit of plan.removed)
          if (unit.kind === 'list-item') scopes.add(unit)
      }
      capture.onBatch(new Set(), scopes)
      const rendered = unitDom.render?.(plan.sources, replace)
      if (!rendered) return applyFallback('lute-not-ready')
      // `render` writes nothing when a built element has another kind than its source.
      if (
        rendered.length !== plan.sources.length ||
        rendered.some((unit, i) => unit.kind !== plan.sources[i].kind)
      )
        return applyFallback('window-without-kind')
      // The capture sees the replacement while the model still lists the removed units (handoff 2.4).
      unitDom.drain()
      current.commitApply(plan, rendered)
      emitApplied(rendered, rows?.table, neighbours)
      restartSoon()
      return APPLIED
    },
    reopenTyping(text) {
      if (!model || !live()) return
      model.rebind(normalizeEol(text))
      if (model.state !== 'live') {
        offReason = model.offReason ?? 'pairing-failed'
        return
      }
      // The model no longer knows which units hold the typing: the next publication is whole-text, so
      // it carries the DOM with the typing (a stale one is refused visibly, Task 646).
      model.markStructureDirty('root')
      preTouchFallback = true
    },
    adoptHostEpoch(text, epoch) {
      if (!model || !live()) return
      const newEpoch = epoch !== host?.epoch
      host = { text: normalizeEol(text), epoch }
      modeReentry = false
      awaited = undefined
      awaitingWrite = false
      stale = false
      exactSequences.clear()
      prediction = undefined
      confirmed = true
      // As `onRebind` for a host-own epoch: no unit keeps a `changedAt` of the epoch that ended.
      if (newEpoch && changedAtSet) {
        resetChangedAt(model.units)
        changedAtSet = false
      }
    },
    rebuildAfterExact(text) {
      if (!host || !domComplete) return
      host = { text: normalizeEol(text), epoch: host.epoch }
      buildSoon()
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
      capture.invalidate()
      modeReentry = false
      cancelBuild()
      teardown()
      host = undefined
      confirmed = false
      awaited = undefined
      awaitingWrite = false
      offReason = reason
    },
    onModeChange(mode) {
      if (mode === 'ir') {
        // Back in IR with the complete edit DOM: the first IR post asks for the host bytes, and the
        // matched `rebind` builds the model (3.6). A model that is live or was never built does nothing.
        if (!model && offReason === 'mode' && domComplete) modeReentry = true
        return
      }
      capture.invalidate()
      modeReentry = false
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
      if (!live() || !model) return reentryPost(sequence, options)
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
      changedAtSet = true
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
      emitPublished(result)
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
    deltaPort: () => port,
    historyPort: () => capture.port,
    canPublishDelta: () => live() && deps.getMode() === 'ir',
    ownsText: () =>
      live() &&
      deps.getMode() === 'ir' &&
      !awaitingNow() &&
      !stale &&
      confirmed,
    onWholeTextPublished(sequence, options) {
      if (!live()) return
      if (options?.requestId !== undefined)
        exactSequences.set(options.requestId, sequence)
      publicationBase(sequence)
    },
    recordFallback: countFallback,
    isLive: () => live(),
    liveUnits() {
      if (!model || !live()) return undefined
      const root = deps.getRoot()
      const units: LiveUnit[] = []
      for (const unit of model.units) {
        if (unit.el ?? unit.members[0]) units.push(toLiveUnit(unit, root))
      }
      return units
    },
    confirmedLines() {
      const units = session.confirmedUnits()
      if (!units || !model) return undefined
      const { text } = model
      const lines: UnitLines[] = []
      for (const unit of units) {
        const el = unit.el ?? unit.members[0]
        if (!el) continue
        lines.push({
          el,
          startLine: unit.startLine,
          endLine: unit.startLine + newlinesBetween(text, unit.start, unit.end),
        })
      }
      return lines
    },
    liveUnitOf(node) {
      if (!model || !live()) return undefined
      return liveUnitFor(model, deps.getRoot(), node)
    },
    markExplicitAtCaret() {
      if (!model || !live()) return
      const node = win.getSelection?.()?.anchorNode ?? null
      let el: Element | null =
        node instanceof Element ? node : (node?.parentElement ?? null)
      while (el) {
        const unit = model.unitOf(el as HTMLElement)
        if (unit) {
          model.markExplicit(unit)
          return
        }
        el = el.parentElement
      }
    },
    onUnitsChanged(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      capture.invalidate()
      cancelBuild()
      teardown()
      listeners.clear()
      if (deps.e2e) {
        delete (win as unknown as Record<string, unknown>)
          .__vmdeModelShadowStats
        delete (win as unknown as Record<string, unknown>)
          .__vmdeModelShadowAudit
        delete (win as unknown as Record<string, unknown>).__vmdeModelTextDigest
      }
    },
  }
  return session
}
