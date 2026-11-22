import {
  type MovableBlock,
  scanMovableBlocks,
} from '../../../src/shared/block-move'
import type { HostMessage, WebviewMessage } from '../../../src/shared/protocol'
import {
  type DeltaFallbackReason,
  type DeltaSessionPort,
  type DeltaSync,
  type LogicalPublisher,
  type PrepareResult,
  publicationTraceContext,
  setPublicationTraceContext,
  type TouchedProof,
} from './delta-sync'
import { installModelSync } from './model-structure'
import {
  type LinePosition,
  offsetToPosition,
  type TextChange,
} from './change-set'
import {
  type ApplyFallbackReason,
  type ApplyPlan,
  createTextModel,
  type HostUnit,
  modelInternals,
  type SyncResult,
  type TextModel,
  type Unit,
} from './text-model'
import {
  createUnitDom,
  type PreparedRender,
  type UnitDomControl,
} from './unit-dom'
import {
  createUnitSchedule,
  installPreTouchListeners,
  type UnitSchedule,
} from './unit-schedule'
import {
  type HistoryModelPort,
  type LiveUnit,
  type UnitLines,
  type UnitMode,
  type UnitsChange,
  SOURCE_UNITS,
  unitModeOf,
  WYSIWYG_UNITS,
  DEFINITION_UNITS,
  type DefinitionContext,
} from '../util/unit-changes'
import {
  type BackgroundJob,
  backgroundSchedulerOf,
} from '../util/background-budget'
import { writeQuietly } from '../util/mutation-impact'
import { createDefinitionIndex, type DefinitionIndex } from './definition-index'
import {
  type FootnoteInfo,
  normalizeLabel,
  scanModelBlocks,
  stripDefinitionContext,
} from './definition-units'
import { scanSourceChunks } from './sv-chunks'
import {
  createSourceHistoryCapture,
  createSourceUnitDom,
  sourceUnitText,
} from './sv-units'
import { createUnitCapture } from './unit-capture'
import { withDefinitionReferences } from './apply-text'
import { webviewContextDrainFor } from '../chrome/webview-context'
import { createReplayBudget, type ReplayBudget } from './replay-budget'
import {
  createReplayTarget,
  DELTA_TEXT_LIMIT,
  groupsOfHunks,
  type ReplayTarget,
  type SupersedingHunks,
  supersede,
} from './replay-target'
import { writeSelectionKeepingIntent } from '../editing/caret'
import {
  committedInput,
  type InputIntent,
  needsInputIntent,
  replayUnitCaret,
} from '../editing/replay-selection'
import {
  type ExactHistoryHunks,
  exactHistoryHunks,
} from '../editing/rewrap-command'
import {
  type ModeLute,
  type SpinLute,
  type UnitLute,
  unitLuteOf,
} from './unit-lute'

// Task 733 (004-C): one text model per Vditor instance, kept beside the edit-sync controller. It
// builds the model from the host text once the complete IR edit DOM exists, tracks the DOM through
// the unit adapter, and, in this task, only shadows each whole-text publication: it predicts the
// bytes and compares them with the host's `rebind` answer. Nothing it computes is posted yet.

type U = Unit<HTMLElement>
/** Task 733 / 036 (step C): the replay operations of the delta publisher the session uses. */
type ReplaySync = Pick<
  DeltaSync,
  | 'setLogicalPublisher'
  | 'publish'
  | 'postAgainstHost'
  | 'postReplayDelta'
  | 'reserveReplayHistory'
  | 'postReservedHistory'
  | 'lastPostedSequence'
  | 'replayLedger'
  | 'oldestReplay'
>
type ReplayChanges = Parameters<DeltaSync['postReplayDelta']>[0]
type RebindMessage = Extract<HostMessage, { command: 'rebind' }>
type ReplayAckMessage = Pick<
  Extract<HostMessage, { command: 'replay-ack' }>,
  'epoch' | 'replayOp' | 'acceptedSequence'
>
type ReplayStatusMessage = Pick<
  Extract<HostMessage, { command: 'replay-status' }>,
  'epoch' | 'replayOp' | 'applied' | 'acceptedSequence'
> & { state: string }
/**
 * 036 S5.2 (S5 design rev 2 section 2): the state of a record's plan dry run. `skipped`: the model text was
 * not the record's end (or no model or hunks), so nothing is known. `interrupted`: the key arrived while
 * the check had yielded to its budget.
 */
type HunkCheckState =
  | 'pending'
  | 'running'
  | 'interrupted'
  | 'skipped'
  | 'completed'
interface HunkCheck {
  state: HunkCheckState
  /** The next hunk to check: the number checked. */
  next: number
  /** The hunk count, known once the check reads the record. */
  total: number
  /** The checked hunks whose plan fell back. */
  refused: number
  /** The first fallback reason (a plan reason kind). */
  reason: string | undefined
}
/** Task 733 / 036 (B0): the replay control posts of the session (no document text). */
type ReplayControlMessage = Extract<
  WebviewMessage,
  {
    command:
      | 'replay-abandon'
      | 'replay-query'
      | 'host-state-query'
      | 'recovery-done'
  }
>

/**
 * Task 733 / 036 (E, E2): what a host text did to an active replay. 'none': no replay is active (today's
 * path). 'recovering': the replay ended and the host text renders through the bounded writer. 'fallback':
 * the replay ended and the host text cannot render by units (the caller renders it whole).
 */
type ReplayRecovery = 'none' | 'recovering' | 'fallback'

/**
 * Task 733 / 036 (E2, fix design 3.6): the proof a refused replay delta needs to be reapplied to the host
 * text: the unit that held it, as it was in `L` before the edit (a slice of the text then, no copy), its
 * index, the edit's offset in it and the bytes it replaced and wrote. Undefined: no proof (an edit over
 * several units, outside every unit, or inside a unit that held a pending group).
 */
interface RecoveryProof {
  readonly unitText: string
  readonly unitIndex: number
  readonly inUnit: number
  readonly oldText: string
  readonly insert: string
}

/** Task 733 / 036 (E2): a replay delta kept until its acknowledgement; `replayOp` undefined: never posted. */
interface RecoveryOp {
  readonly epoch: number
  readonly replayOp: number | undefined
  readonly proof: RecoveryProof | undefined
}

/**
 * 036 core C2 (R33.4, R32.2): a running replay engine. `token` owns the replay budget account; `frame` is
 * the scheduled callback; `stopped` makes every later callback and `endRun` a no-op; `resolve` settles the
 * sliced restore's promise once.
 */
interface ReplayRun {
  readonly sequence: number
  readonly state: ReplayTarget
  readonly token: number
  frame: number | undefined
  stopped: boolean
  /** 036 core C3 (L1): the previous frame of this run was a skip; the next one makes progress. */
  yieldedLast: boolean
  readonly resolve: (ok: boolean) => void
}

/** 036 core C4 (M1): the reused endpoints of an admission read (no allocation per input). */
const EMPTY_NODE = { nodeType: 0 } as unknown as Node
const EMPTY_RANGE = { startContainer: EMPTY_NODE, endContainer: EMPTY_NODE }
const ADMIT_RANGE = { startContainer: EMPTY_NODE, endContainer: EMPTY_NODE }
/** 036 core C4: the delivery absorb costs kept for the end-to-end stats. */
const DELIVERY_SAMPLES = 256
/** 036 core C3 (L1): an input this recent packs one atomic per progress frame. */
const INPUT_PACK_MS = 150
/** 036 core C3: the range the caret group render reads (written, never allocated per frame). */
const CARET_RANGE = { from: 0, to: 0 }

/**
 * H2 fix design rev2 (D6.1): a `replayOp` no operation ever has. Its status tells the epoch apart: an ended
 * epoch answers `ended`, the current one `unknown`.
 */
const ABANDON_PROBE_OP = Number.MAX_SAFE_INTEGER

/**
 * Task 733 / 036 (E): a recovery atomic aims at about this many characters (fix design 3.5). H2 fix design
 * rev2 (S3 review point 3): a chunk is cut only at top-level unit boundaries of both the rendered text
 * and the host text; a single unit above it renders alone and is counted `oversize`.
 */
const RECOVERY_CHUNK = 4096
/** Characters of host text one recovery step scans for its block boundaries at first (doubled up to the cap). */
const RECOVERY_SCAN = 2 * RECOVERY_CHUNK
/** The scan cap: a host block that does not end within it is counted unsupported (whole render). */
const RECOVERY_SCAN_LIMIT = 80_000
/** Segments per side a refused recovery chunk grows to, one at a time, before the whole render. */
const RECOVERY_GROW = 4

interface SpanUnit {
  readonly kind: string
  readonly start: number
}

/** Index of the last unit whose start is at or before `offset`; -1 when none. */
function unitAtOrBefore(units: readonly SpanUnit[], offset: number): number {
  let lo = 0
  let hi = units.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (units[mid].start <= offset) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

const inListRun = (units: readonly SpanUnit[], at: number): boolean =>
  at > 0 &&
  at < units.length &&
  units[at].kind === 'list-item' &&
  units[at - 1].kind === 'list-item'

/**
 * H2 fix design rev2 (S3 review point 3): the common-prefix cut moved back to a top-level boundary of the
 * rendered text: the start of the unit before the one holding `prefix` (a later line can change it: a
 * setext underline, a lazy continuation), and before every item of its list run. The bytes before it are
 * equal in both texts, so it is a block boundary of the host text too.
 */
function alignedRecoveryStart(
  units: readonly SpanUnit[],
  prefix: number,
): number {
  let at = unitAtOrBefore(units, prefix)
  if (at > 0) at--
  while (inListRun(units, at)) at--
  return at <= 0 ? 0 : units[at].start
}

/**
 * The common-suffix cut moved forward to a top-level boundary: past the unit after the one holding the
 * first suffix byte and past its list run. Returns the length of the aligned tail, which both texts
 * share byte for byte (it lies inside the common suffix).
 */
function alignedRecoveryTail(
  units: readonly SpanUnit[],
  length: number,
  suffix: number,
): number {
  let at = unitAtOrBefore(units, length - suffix) + 2
  while (inListRun(units, at)) at++
  return at < units.length ? length - units[at].start : 0
}

/** Characters `a` and `b` share from `from`, at most `limit`. */
function commonHead(a: string, b: string, from: number, limit: number): number {
  let n = 0
  while (n < limit && a.charCodeAt(from + n) === b.charCodeAt(from + n)) n++
  return n
}

/** Characters `a` before `aEnd` and `b` before `bEnd` share, at most `limit`. */
function commonBack(
  a: string,
  b: string,
  aEnd: number,
  bEnd: number,
  limit: number,
): number {
  let n = 0
  while (n < limit && a.charCodeAt(aEnd - 1 - n) === b.charCodeAt(bEnd - 1 - n))
    n++
  return n
}

/** Block `at` continues the list run of block `at - 1` (scanned host blocks). */
const inBlockRun = (blocks: readonly MovableBlock[], at: number): boolean =>
  at > 0 &&
  at < blocks.length &&
  blocks[at].kind === 'list-item' &&
  blocks[at - 1].kind === 'list-item' &&
  blocks[at].listRun === blocks[at - 1].listRun

/**
 * S4 repair (fix 2): `text` holds `insert` at `from`, has the length of the kept text plus `insert`, and
 * keeps the characters next to the write (`before` at `from - 1`, `after` right after `insert`; -1 at an end).
 */
function committedExactly(
  text: string,
  from: number,
  insert: string,
  kept: number,
  before: number,
  after: number,
): boolean {
  const end = from + insert.length
  return (
    text.length === kept + insert.length &&
    text.startsWith(insert, from) &&
    (from > 0 ? text.charCodeAt(from - 1) : -1) === before &&
    (end < text.length ? text.charCodeAt(end) : -1) === after
  )
}

/** `a` and `b` hold the same characters over `[from, from + length)`. No allocation. */
function equalSpan(
  a: string,
  b: string,
  from: number,
  length: number,
): boolean {
  for (let at = from; at < from + length; at++)
    if (a.charCodeAt(at) !== b.charCodeAt(at)) return false
  return true
}

/** The lengths of the common prefix and the common suffix of `a` and `b` (they never overlap). O(n), no allocation. */
function commonEnds(a: string, b: string): { prefix: number; suffix: number } {
  const limit = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < limit && a.charCodeAt(prefix) === b.charCodeAt(prefix))
    prefix++
  let suffix = 0
  while (
    suffix < limit - prefix &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
  )
    suffix++
  return { prefix, suffix }
}

/** The index of the top-level unit whose range holds `offset` (start inclusive, end inclusive), or -1. */
function topUnitIndexAt(
  units: readonly { start: number; end: number }[],
  offset: number,
): number {
  let low = 0
  let high = units.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (units[mid].start <= offset) {
      found = mid
      low = mid + 1
    } else high = mid - 1
  }
  return found >= 0 && offset <= units[found].end ? found : -1
}

/**
 * Task 733 / 036 (E2, fix design 3.6): the offset a refused edit reapplies at, or -1 when its base or position
 * is not proven: its unit's source before the edit must occur exactly once, at the same index, with the
 * edit's old bytes at the mapped offset inside it.
 */
function provenOffset(
  built: { text: string; units: readonly { start: number; end: number }[] },
  proof: RecoveryProof,
): number {
  const { text, units } = built
  const unit = units[proof.unitIndex]
  if (!unit || !unitSourceIs(text, unit, proof.unitText)) return -1
  let count = 0
  for (const other of units)
    if (unitSourceIs(text, other, proof.unitText)) count++
  if (count !== 1) return -1
  const from = unit.start + proof.inUnit
  return from + proof.oldText.length <= unit.end &&
    text.startsWith(proof.oldText, from)
    ? from
    : -1
}

/** The unit's source in `text` is exactly `source`. */
const unitSourceIs = (
  text: string,
  unit: { start: number; end: number },
  source: string,
): boolean =>
  unit.end - unit.start === source.length && text.startsWith(source, unit.start)

/** Task 733 / 036 (F8): an exact replay not handled after this is abandoned. */
const EXACT_WATCHDOG_MS = 5000
type OffReason = NonNullable<TextModel<HTMLElement>['offReason']>

/** Who asks for an apply (shared rules 3.7): an exact action, a host update, a refusal rollback. */
type ApplyOrigin = 'exact' | 'host' | 'rollback'
/** A checked apply that has written nothing yet (`prepareApply`, H2 fix design rev2 D3.3). */
interface PreparedApply {
  model: TextModel<HTMLElement>
  unitDom: ReturnType<typeof createUnitDom>
  plan: ApplyPlan<HTMLElement>
  rows: NonNullable<ApplyPlan<HTMLElement>['tableRows']>[number] | undefined
  replace: HTMLElement[]
  commit: PreparedRender
}
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

/** Task 733 / 036 (Q-G): an ATX heading line start. */
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/u

/** Quiet time after the last delta before the proof queues are rebuilt. */
const RESTART_QUIET_MS = 250

/** Task 733 / 036 (step C): newlines of `text` in `[from, to)`. */
function countLines(text: string, from: number, to: number): number {
  let lines = 0
  for (
    let at = text.indexOf('\n', from);
    at !== -1 && at < to;
    at = text.indexOf('\n', at + 1)
  )
    lines++
  return lines
}

/** Task 733 / 036 (step C, 2.3): per pending group, newlines of its target bytes minus those of its `R` bytes. */
function lineDeltas(state: ReplayTarget, rendered: string): Int32Array {
  const out = new Int32Array(state.count)
  const r = { from: 0, to: 0 }
  const t = { from: 0, to: 0 }
  for (let g = 0; g < state.count; g++) {
    if (!state.isPending(g)) continue
    state.rangeR(g, r)
    state.rangeT(g, t)
    out[g] =
      countLines(state.target, t.from, t.to) -
      countLines(rendered, r.from, r.to)
  }
  return out
}

/** Task 733 / 036 (step C, Q-B): a record's hunks from the move's start (`L`) to its target. */
function supersedingHunks(
  hunks: SupersedingHunks,
  side: 'before' | 'after',
): SupersedingHunks {
  return side === 'after'
    ? hunks
    : {
        oldStarts: hunks.newStarts,
        oldEnds: hunks.newEnds,
        newStarts: hunks.oldStarts,
        newEnds: hunks.oldEnds,
      }
}

/**
 * Task 733 / 036 (step C): the text point `offset` rendered characters into `el`. At the end of a text
 * node inside a Markdown marker the point moves to the next node unless `inMarker` (the original point
 * sat inside a marker): the marker affinity of H2 fix design rev2, D1.1.
 */
function textPoint(
  el: Element,
  offset: number,
  inMarker = true,
): { node: Node; offset: number } {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let rest = offset
  let last: Text | undefined
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (
      rest < text.data.length ||
      (rest === text.data.length &&
        (inMarker || text.parentElement?.closest('.vditor-ir__marker') == null))
    )
      return { node: text, offset: rest }
    rest -= text.data.length
    last = text
  }
  return last
    ? { node: last, offset: last.data.length }
    : { node: el, offset: 0 }
}

/**
 * H2 fix design rev2 (D3.3): the `beforeinput` types that remove exactly an expanded selection (the
 * set of `E/ir-whole-document-edit.ts`); Cut and drag have their own events.
 */
const SELECTION_DELETE_INPUTS: ReadonlySet<string> = new Set([
  'deleteContent',
  'deleteContentBackward',
  'deleteContentForward',
  'deleteWordBackward',
  'deleteWordForward',
  'deleteSoftLineBackward',
  'deleteSoftLineForward',
  'deleteHardLineBackward',
  'deleteHardLineForward',
])

/** Task 733 / 036 (step C): a key that edits text. */
const isEditingKeyName = (key: string): boolean =>
  key.length === 1 ||
  key === 'Enter' ||
  key === 'Backspace' ||
  key === 'Delete' ||
  key === 'Tab'

/**
 * A (start, line) pair at or before `offset`, from the top-level units (ascending by start): the text
 * before `offset` is the same before and after the sync, so the unit's line is valid for both. This
 * keeps the position scan of a delta from starting at offset 0.
 */
/** The deepest unit (table, row, cell) that starts at or before `offset`; binary search per level. */
function deepestUnitAt(
  model: TextModel<HTMLElement>,
  offset: number,
): U | undefined {
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
  return found
}

function lineHint(
  model: TextModel<HTMLElement>,
  offset: number,
): { offset: number; line: number } | undefined {
  // The deepest unit at or before `offset` (table, row, cell), so a cell edit near the end of a
  // large table does not scan the table from its first line (m5).
  const found = deepestUnitAt(model, offset)
  return found ? { offset: found.start, line: found.startLine } : undefined
}

/** Text size up to which a prediction mismatch counts as a model error (agreement subset). */
const AGREEMENT_MAX_CHARS = 100_000

/** Task 733 / 015: the modes a model serves: IR and WYSIWYG units (013) and the Source model. */
type ServedMode = UnitMode | 'sv'

/** Task 733 / 022 (Q-183): a history transition the session publishes with exact host bytes at the answer. */
interface HeldTransition {
  kind: 'undo' | 'redo'
  before: string
  after: string
}

export interface ModelSessionDeps {
  win: Window
  /** The IR edit root, or null while it does not exist. */
  getRoot(): HTMLElement | null
  /** The live (wrapped) Lute of the editor, or null. */
  getLute(): UnitLute | null
  getMode(): string | null
  /** Task 733 / 013: WYSIWYG units on; default WYSIWYG_UNITS. Tests pass false to prove today's path. */
  wysiwygUnits?: boolean
  /** Task 733 / 015: the Source root (`pre.vditor-sv`), or null while it does not exist; absent: no Source model. */
  getSourceRoot?(): HTMLElement | null
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
  /**
   * Task 733 / 017: the ToC option is on (a `[toc]` line renders as a table of contents). Absent: read at
   * build from the IR root (a top-level TOC block present).
   */
  tocEnabled?(): boolean
  /** Task 733 / 036: the host admitted the replay pair of this Find request (`rebind.exactRequestId`). */
  confirmExactHistory?(requestId: string): void
  /** Task 733 / 036: the host's FIFO dropped this Find request's pair (`rebind.exactEvicted`). */
  evictExactHistory?(requestId: string): void
  /**
   * Task 733 / 036 (B0, 3.5, 3.7): posts `replay-abandon` (a failed slice), `replay-query` (the watchdog) and
   * `host-state-query` (a refused or ended operation).
   */
  postReplay?(message: ReplayControlMessage): void
  /** Task 733 / 036 (step B): the hunks of a Find record by request ID; default `exactHistoryHunks`. */
  exactHunksOf?(requestId: string): ExactHistoryHunks | undefined
}

export interface ModelSession {
  /**
   * Task 733 / 036 (step D, 4.2): the replay account the unit feed hands to deferred consumers (section
   * fold, table resize); they mark what a replay write schedules and run it charged.
   */
  replayAccount?(): ReplayBudget
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
   * Task 733 / 022 (Q-183): Vditor's engine moved the history while a whole post awaits its rebind
   * answer. True when the session keeps the text from before that post and takes over the
   * publication; false keeps today's path.
   */
  holdHistoryTransition(
    kind: 'undo' | 'redo',
    publish: (transition: HeldTransition) => number | undefined,
  ): boolean
  /**
   * True while a held transition waits for the answer: the whole-text post sites post nothing. O(1).
   * H2 fix design rev2 (D6.3): `whole` asks for a whole-text post, which is also held while a replay is
   * live, abandoned or recovering (its typing goes out through the logical publisher).
   */
  publicationHeld(whole?: boolean): boolean
  /**
   * Task 733 / 036 (F6): a `history-exact` with this sequence was posted. Publication is held until its
   * matched answer (joined with the final restore slice), a host text or a refusal.
   */
  awaitExactHistory(
    sequence: number,
    replay?: { epoch: number; replayOp: number; requestId: string },
  ): void
  /**
   * Task 733 / 036 (B0, 3.7): a `replay-ack` that covers the awaited history operation completes the wait
   * with the record's target text (`targetOf`, by the Find request ID); true when it did.
   */
  onReplayAck(
    message: ReplayAckMessage,
    targetOf?: (requestId: string) => string | undefined,
  ): boolean
  /** Task 733 / 036 (B0, 3.5): `applied` for the awaited operation joins as the ack does. */
  onReplayStatus(
    message: ReplayStatusMessage,
    targetOf?: (requestId: string) => string | undefined,
  ): boolean
  /**
   * Task 733 / 036 (F8): an exact replay is not handled yet: awaited, slicing, or abandoned until the
   * resync update lands. The unit history refuses editing input and history moves while true. O(1).
   */
  exactBusy(): boolean
  /**
   * Task 733 / 036 (step C, fix design 2.6): the publisher of the replay operations (`replay-reserve`,
   * replay deltas, the logical publisher hand-over). Bound once the delta publisher exists.
   */
  bindReplaySync(sync: ReplaySync | undefined): void
  /** Task 733 / 036 (step C): a replay's logical text is live; input and history moves go through it. O(1). */
  replayLive(): boolean
  /**
   * 036 core C2 (R3.3, R4.3): publishes the outstanding user edits of their originating epoch through the
   * live publisher (the replay publisher during a replay, the delta publisher otherwise), then the pending
   * reapplication of a whole recovery (R5.1). Called before the surface or the session goes away: a user
   * mode switch at Vditor's `setEditMode`, `onModeChange`, and a user teardown. Nothing for an edit of an
   * ended epoch.
   */
  flushUserEdits(): void
  /**
   * 036 core C3 (L1): a trusted user input arrived (from the format hotkey guard). The next replay or
   * recovery frame yields to it; while it is under 150 ms old, each progress frame runs one atomic. O(1).
   */
  noteInput(): void
  /**
   * 036 core C2 (R5.2): the logical replay text `L` while a replay is live and the model serves IR, else
   * undefined. A read with no side effects; a switch out of IR during a replay opens with it.
   */
  replayLogicalText(): string | undefined
  /**
   * H2 fix design rev2 (review point 4): an abandoned replay lost its logical text (a mismatch or an input that
   * could not be translated): every edit is refused before it reaches the DOM until the resync. O(1).
   */
  editsRefused(): boolean
  /**
   * H2 fix design rev2 (D6.1): before the delta publisher follows the newer `epoch` of an update, the
   * typing of an abandoned replay not posted yet goes out as an operation of the old epoch, with the old
   * epoch's next `replayOp`, so the host keeps it as a recovery entry. Nothing when no replay is abandoned.
   */
  flushAbandonedInput(epoch: number | undefined): void
  /**
   * Task 733 / 036 (step C, 2.6-2.7): before the default action of an input event during a replay: the
   * pending groups at the selection's endpoints render, the selection is kept across them, and the
   * input's intent is captured (2.3). Copy and Cut over pending text write the logical bytes.
   */
  beforeReplayInput(event: Event): void
  /**
   * 036 core C4 (M1): whether an input at `range` during a replay or a recovery can be posted with its
   * bytes; true outside both. A read with no side effects (`refuseReplayInput` refuses and counts).
   */
  replayAcceptsInput(range: {
    startContainer: Node
    endContainer: Node
  }): boolean
  /** 036 core C4 (M1): refuses an input before it reaches the DOM and counts `replayInputRefused`. */
  refuseReplayInput(event: Event): void
  /**
   * 036 core C5 (R34.3, R35.3): called first by the router's `update` handler and `adoptInlineInitEpoch`.
   * While a composition is active during a replay or a recovery, the message is queued for `deliver` and
   * true is returned; the queue is released once per composition (its end, or a forced release). A
   * delivered message is never queued again.
   */
  deferUpdateForComposition?<M extends object>(
    msg: M,
    deliver: (msg: M) => void,
  ): boolean
  /**
   * 036 core C6 (S1, R2.4, R3.4): the replay's own `history-exact` is the only awaited publication, no host
   * write is pending and the logical publisher is live: a Save may answer from the model with no
   * serialization. O(1).
   */
  ownsHostForSave(): boolean
  /**
   * 036 core C6 (S2, R33.3): a Save during a replay, a recovery or a composition must not reply yet: a
   * composition is active, a rebind other than the replay's own is awaited, a host write is pending, a
   * recovery renders, or the model holds unpublished user edits. False outside those states. Drains the DOM.
   */
  saveBlocked(): boolean
  /**
   * 036 core C6 (S2): grows at a failed absorb, a `'fallback'` publication, an abandon or a resync during a
   * replay. A Save whose mark changed after its request is `unproven`. O(1).
   */
  saveProofMark(): number
  /** 036 core C6 (S2): counts a Save that replied unproven (`saveUnproven`, a number only). */
  countSaveUnproven(): void
  /**
   * 036 core C6 (S2): the session's Save wakes: a host write outcome or end, a refusal or resync, the
   * replay's end, `recovery-done` and `failRecovery`, a composition release, a mode change and an ordinary
   * `rebind` answer. Returns the removal.
   */
  onSaveWake(listener: () => void): () => void
  /** Task 733 / 036 (step C, 2.7): renders the group of the caret intent when it is still pending. */
  renderReplayCaretGroup(): void
  /** Task 733 / 036 (step C, 2.6): publishes the typing the model has not published, ahead of a history move. */
  absorbReplayInput(): void
  /**
   * 036 core C4 (R35.1): the transition wrapper's drain before a move during a replay: `dom.drain()`, then
   * the user mutations as replay ops (the delivery publisher).
   */
  drainReplayInput(): void
  /** 036 core C4 (K12): counts a reentrant history move the wrapper refused. */
  refuseReplayReentry(): void
  /**
   * Task 733 / 036 (step C, 2.6, Q-B): an untagged Undo or Redo during a replay: its `replayOp` is
   * reserved at the key and its restored change goes out as the reserved `history-delta`.
   */
  publishReplayHistory(
    kind: 'undo' | 'redo',
    steps: number,
  ): 'delta' | 'nothing'
  /**
   * Task 733 / 036 (step C, 2.6): the logical source of the table that holds `table` (its `l` range),
   * after its pending groups rendered; undefined outside a replay or when it cannot be read.
   */
  replayTableSource(table: HTMLElement): string | undefined
  /**
   * Task 733 / 036 (E, E2, fix design 3.5-3.6): a host text that ends an active replay: an `update` or a
   * `host-state` with a newer epoch (`epoch`, with `replayAfterOp` of the ended epoch), or the host text of
   * a refused history post (`epoch` undefined: the epoch stays). The replay ends at once; the host text
   * renders through the bounded writer over the next frames, with no whole-document read; then every
   * refused replay delta with a proven base and position is reapplied as an operation of the new epoch
   * (`recoveryOf`), and `recovery-done` names the ended epoch. `whole` renders the host text whole when it
   * cannot render by units. 'none' when no replay is active or the epoch is not newer.
   */
  recoverReplay(
    text: string,
    epoch: number | undefined,
    replayAfterOp: number | undefined,
    whole: (text: string) => void,
  ): ReplayRecovery
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
  /** Task 733 / 015: the mode whose model is live (`sv`: the Source model); undefined when off. */
  liveMode(): ServedMode | undefined
  /** Task 733 / 015: the model text when the model owns it and no typing is unpublished (a mode switch reads it). */
  modeSwitchText(): string | undefined
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
  /** Task 733 / 017: the referenced definitions of `source`; undefined when not live or none is referenced. */
  definitionContextFor(source: string): DefinitionContext | undefined
  /** Task 733 / 017: number and tooltip of a footnote label; undefined when not live or not defined. */
  footnoteOf(label: string): FootnoteInfo | undefined
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
  const nested =
    unit.kind === 'cell' ||
    unit.kind === 'list-item' ||
    unit.kind === 'footnote'
  const top = nested ? rootChild(first, root) : first
  return {
    el: first,
    members: unit.members,
    kind: unit.kind as LiveUnit['kind'],
    top,
  }
}

/** Task 733 / 017: the ToC option from the deps, else from the root (a top-level TOC block). */
function tocEnabledFor(deps: ModelSessionDeps, root: HTMLElement): boolean {
  if (deps.tocEnabled) return deps.tocEnabled()
  for (const child of Array.from(root.children))
    if (child.getAttribute('data-type') === 'toc-block') return true
  return false
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
  scopes: readonly HTMLElement[]
}

/** The scopes of a change consumers run their full pass for, or of one that names nothing (shared, never written). */
const NO_SCOPES: readonly HTMLElement[] = Object.freeze([])

const elementOrder = (a: HTMLElement, b: HTMLElement): number =>
  a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1

/** Adds the connected elements of `elements` under `root` (never the root itself) to `out`. */
function addConnected(
  elements: ReadonlySet<HTMLElement>,
  root: HTMLElement,
  out: HTMLElement[],
): void {
  for (const el of elements)
    if (el !== root && el.isConnected && root.contains(el)) out.push(el)
}

/**
 * Task 733 / 012-12 (D-13 design section 1.2): the elements consumers rescan. The members of the
 * changed units, then the elements the batches inserted and the spun top-level blocks; in document
 * order, without duplicates, and an element inside another scope element is dropped. Never a whole
 * table or list for a cell, row or item change: those stay in `structural`.
 */
function resolveScopes(
  changed: readonly LiveUnit[],
  root: HTMLElement | null,
  sets: BatchSets,
  kept: BatchSets | undefined,
): readonly HTMLElement[] {
  if (!root) return NO_SCOPES
  const all: HTMLElement[] = []
  for (const unit of changed) pushConnected(unit.members, all)
  addConnected(sets.inserted, root, all)
  addConnected(sets.spun, root, all)
  if (kept) {
    addConnected(kept.inserted, root, all)
    addConnected(kept.spun, root, all)
  }
  if (all.length === 0) return NO_SCOPES
  all.sort(elementOrder)
  // In document order an ancestor comes before its descendants: comparing with the last kept element
  // drops duplicates and nested elements in one pass.
  let last: HTMLElement | undefined
  let count = 0
  for (const el of all) {
    if (last?.contains(el)) continue
    all[count++] = el
    last = el
  }
  all.length = count
  return all
}

/** Adds the leaf units to `changed` (once per element) and table-level marks to `structural`; removed units are dropped. */
function resolveUnits(
  units: ReadonlySet<Unit<HTMLElement>> | undefined,
  root: HTMLElement | null,
  changed: LiveUnit[],
  structural: Set<HTMLElement>,
  seen: Set<HTMLElement>,
): void {
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

/** The marks of one or more observer batches, collected for one emitted change. */
interface BatchSets {
  changed: ReadonlySet<Unit<HTMLElement>> | undefined
  structure: ReadonlySet<'root' | Unit<HTMLElement>> | undefined
  /** The top-level elements of block spins (Task 733 / 012-1). */
  spun: ReadonlySet<HTMLElement>
  /** The elements inserted under a list, a table section or row, or the root (Task 733 / 012-12). */
  inserted: ReadonlySet<HTMLElement>
  /** A root notice that is no block spin: consumers run their full pass. */
  rootUnexplained: boolean
}

function resolveStructure(
  sets: BatchSets,
  root: HTMLElement | null,
  structural: Set<HTMLElement>,
): boolean {
  let whole = false
  for (const scope of sets.structure ?? []) {
    if (scope === 'root') {
      // A block spin keeps the root notice; only a root notice of another cause is a whole change.
      if (sets.rootUnexplained) whole = true
      continue
    }
    const first = scope.el ?? scope.members[0]
    if (first?.isConnected) structural.add(rootChild(first, root))
  }
  for (const top of sets.spun)
    if (top.isConnected && top.parentElement === root) structural.add(top)
  return whole
}

/**
 * The batch sets as live units and top-level elements; units whose element left the document are
 * dropped. `kept` is what a feed frame already reported and the sync now writes (Task 733 / 012-1).
 */
function resolveBatch(
  sets: BatchSets,
  root: HTMLElement | null,
  kept?: BatchSets,
): ResolvedBatch {
  const changed: LiveUnit[] = []
  const structural = new Set<HTMLElement>()
  const seen = new Set<HTMLElement>()
  resolveUnits(sets.changed, root, changed, structural, seen)
  let whole = resolveStructure(sets, root, structural)
  if (kept) {
    resolveUnits(kept.changed, root, changed, structural, seen)
    if (resolveStructure(kept, root, structural)) whole = true
  }
  changed.sort(documentOrder)
  return {
    whole,
    changed,
    structural: Array.from(structural),
    scopes: whole ? NO_SCOPES : resolveScopes(changed, root, sets, kept),
  }
}

/**
 * The scopes of an apply (Task 733 / 012-12): the members of what it rendered (the rows or cells of a
 * row apply, never the table it reports in `changed`), else the members of the neighbour units it
 * reports when it rendered nothing. A table apply that rendered nothing names no scope.
 */
function appliedScopes(
  rendered: readonly HostUnit<HTMLElement>[],
  changed: readonly LiveUnit[],
  table: boolean,
): readonly HTMLElement[] {
  if (changed.length === 0) return NO_SCOPES
  const scopes: HTMLElement[] = []
  for (const listed of rendered) pushConnected(listed.members, scopes)
  if (scopes.length === 0 && !table)
    for (const unit of changed) pushConnected(unit.members, scopes)
  return scopes.length > 0 ? scopes : NO_SCOPES
}

/** Adds the connected elements of `members` to `out`. */
function pushConnected(
  members: readonly HTMLElement[],
  out: HTMLElement[],
): void {
  for (const member of members) if (member.isConnected) out.push(member)
}

/** Task 733 / 019: a Source unit still sits in `root` and its members' text is its proven text. */
function sourceUnitKeepsText(
  unit: Unit<HTMLElement>,
  root: HTMLElement | null | undefined,
): boolean {
  if (unit.canon === undefined) return false
  for (const member of unit.members)
    if (member.parentElement !== root) return false
  return sourceUnitText(unit.members) === unit.canon
}

/** Adds every element of `source` to `target` (the adapter's batch sets are reused, so they are copied). */
function addAll(target: Set<HTMLElement>, source: Iterable<HTMLElement>): void {
  for (const el of source) target.add(el)
}

/** A root notice of these sets came only from block spins. */
const spinOnlyRoot = (sets: BatchSets): boolean =>
  sets.structure?.has('root') === true && !sets.rootUnexplained

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

/**
 * Task 733 / 021 (run 1 repair): the definitions div that holds `node` when the model does not map it
 * yet. A paragraph typed into a definition is spun into a new definitions div, and the model lists it
 * only at the next sync. Until then a key in it must still spin that div alone: Vditor's whole-root spin
 * moves every definition to the document end. Allocates only when such a div holds `node`.
 */
function unmappedDefinitionOf(
  model: TextModel<HTMLElement>,
  root: HTMLElement | null,
  node: Node,
): LiveUnit | undefined {
  const el = node instanceof Element ? node : node.parentElement
  if (!root || !el || el === root || !root.contains(el)) return undefined
  const top = rootChild(el as HTMLElement, root)
  if (
    top.getAttribute('data-type') !== 'link-ref-defs-block' ||
    !top.hasAttribute('data-block') ||
    model.unitOf(top)
  )
    return undefined
  return { el: top, members: [top], kind: 'definition', top }
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
  let definitionIndex: DefinitionIndex | undefined
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
  /**
   * Task 733 / 022 (Q-183): the model text when the last unshadowed whole post went out (kept by
   * reference, no copy), and the transition held until that post's answer.
   */
  let keptBeforePost: string | undefined
  /** Task 733 / 022: history commands refused while a transition was held (a count only, SR-5). */
  let heldHistoryRefusals = 0
  const countHeldRefusal = (): void => {
    heldHistoryRefusals++
  }
  let held:
    | {
        kind: 'undo' | 'redo'
        publish: (transition: HeldTransition) => number | undefined
      }
    | undefined
  /** Entering IR again: the first IR post asks for the host bytes, and its rebind builds the model (3.6). */
  let modeReentry = false
  /** Task 733 / 013: the mode the current model was built for (shared rules 3.12); 015: `sv` for Source. */
  let builtMode: ServedMode | undefined
  /** The mode the model serves for Vditor mode `mode`; O(1), no allocation. */
  const servedModeOf = (mode: string | null): ServedMode | undefined =>
    mode === 'sv'
      ? SOURCE_UNITS && deps.getSourceRoot
        ? 'sv'
        : undefined
      : unitModeOf(mode, deps.wysiwygUnits ?? WYSIWYG_UNITS)
  /** The mode the model serves for Vditor's current mode; O(1), no allocation. */
  const servedMode = (): ServedMode | undefined => servedModeOf(deps.getMode())
  /** The root the live model describes: the Source root for a Source model, else the IR or WYSIWYG root. */
  const modelRoot = (): HTMLElement | null =>
    builtMode === 'sv' ? (deps.getSourceRoot?.() ?? null) : deps.getRoot()
  /** Vditor shows the mode the model was built for. */
  const servesBuiltMode = (): boolean =>
    builtMode !== undefined && servedMode() === builtMode
  /**
   * Run 1 triage 4.3 (R-2): the model is live and Vditor shows its mode. A switch can reach the session
   * late; until then the model of the hidden mode answers for nothing (feed, units, history port).
   */
  const serving = (): boolean => live() && servesBuiltMode()
  let prediction: Prediction | undefined
  let restartTimer: number | undefined
  let preTouchFallback = false
  // Task 733 / 036: the `history-exact` sequence whose answer is awaited; sliced restores still writing;
  // a matched answer kept until the final slice; the watchdog; an abandoned replay awaiting its resync.
  let exactPending: number | undefined
  let exactSlicing = 0
  let exactReply: { content: string; epoch: number } | undefined
  let exactWatchdog: number | undefined
  let exactAbandoned = false
  // Task 733 / 036 (B0): the replay operation of the awaited `history-exact` and its Find request.
  let exactReplay:
    | { epoch: number; replayOp: number; requestId: string }
    | undefined
  // H2 fix design rev2 (D6.1): the operation an abandon named, queried every 5 s until the resync lands.
  let abandonedReplay: { epoch: number; replayOp: number } | undefined
  // Set when a wait ends by a host text, a refusal, teardown or an abandon: a sliced restore stops.
  let exactAbortSlices = false
  // Task 733 / 036 (T0): the last pre-touch proof outcome, recorded in end-to-end runs only.
  let touchedProof: TouchedProof = 'none'
  // Task 733 / 036 (step B, fix design 2.4-2.5): the running replay engine of the awaited history move,
  // and the sequence whose groups all rendered (its acknowledgement then needs no rebind). Counters are
  // kinds and numbers only (SR-5).
  // 036 core C2 (R33.4, R32.2): the run keeps its budget owner token and its scheduled frame; `endRun`
  // ends it once (a `stopped` run ignores every later callback).
  let replayRun: ReplayRun | undefined
  // The replay writes of the current frame, reported as one scoped change after its last atomic (4.3).
  const replayFrameWrites: {
    rendered: readonly HostUnit<HTMLElement>[]
    table: U | undefined
    neighbours: readonly (Element | null | undefined)[]
  }[] = []
  // Task 733 / 036 (fix design 2.2): the idle check of each confirmed Find record: the groups whose plan
  // dry run fell back (an Undo cannot replay them hunk by hunk). Bounded to the last few records.
  // 036 S5.2 (S5 design rev 2 section 2): each check carries its state, its checked and total hunks and
  // the first refusal reason; `refused` counts only checked hunks, so a known refusal before an
  // interruption stays apart from the unchecked ones (`total - next`).
  const hunkChecks = new Map<string, HunkCheck>()
  const hunkQueue: string[] = []
  let replayRendered: number | undefined
  const replayBudget = createReplayBudget({ now: () => deps.now() })
  /** S4 repair (diagnosis 10): the last plan-time refusal of a replay group (`noteRefusal`). */
  let lastRefusal: Record<string, unknown> | undefined
  /**
   * 036 S5.2: the dry-run state of the last key whose check was not a clean completed one (kinds and
   * numbers only); `keyDryRun` is the state at the latest key, copied into `lastRefusal`.
   */
  let lastDryRun: Record<string, unknown> | undefined
  let keyDryRun: HunkCheckState | 'absent' | undefined
  // 036 S5.2: the dry-run state counted at each key (`absent`: no check, never scheduled or evicted).
  const dryRunCounts = {
    pendingAtKey: 0,
    runningAtKey: 0,
    interruptedAtKey: 0,
    skippedAtKey: 0,
    completedAtKey: 0,
    absentAtKey: 0,
  }
  // 036 S5.2 (S5 design rev 2 section 3, review point 3): each route from the engine to the sliced
  // restore before it moves (kinds only).
  const routeCounts = {
    exactReplay: 0,
    exactPending: 0,
    unavailable: 0,
    notLive: 0,
    sv: 0,
    noHunks: 0,
    dryRun: 0,
    dirty: 0,
    startText: 0,
    supersede: 0,
    target: 0,
  }
  /** H2 fix design rev2 (D8.1): a deferred outline render is queued. */
  let outlineScheduled = false
  /** The block scan the IR model was built with; the recovery reads the host text's boundaries with it. */
  let builtScan: ((text: string) => MovableBlock[]) | undefined
  const replayCounts = {
    engine: 0,
    whole: 0,
    /** S4 repair (fix 1): a write that threw (settled as a mismatch). */
    thrown: 0,
    /** S4 repair (fix 6): a frame's first atomic that did not fit and ran alone. */
    forced: 0,
    unbounded: 0,
    mismatch: 0,
    unplannable: 0,
    atomics: 0,
    frames: 0,
    /** 036 core C3 (L1): frames skipped for an input (no replay work, not counted in `frames`). */
    yielded: 0,
    /** 036 core C4 (K12): a history move requested inside the transition wrapper's drain, refused. */
    replayMoveReentry: 0,
    /** 036 core C5 (R34.3, R35.3): a composition's update queue released without its `compositionend`. */
    compositionForced: 0,
    /** 036 core C6 (S2): a Save that replied after a failed absorb, an abandon or a resync (never clean). */
    saveUnproven: 0,
    /** 036 core C4 (M1): an input refused before it reached the DOM during a replay or a recovery. */
    replayInputRefused: 0,
    rebinds: 0,
    // Task 733 / 036 (step C): replay input, superseding moves and the unsliced caret rule.
    typed: 0,
    intents: 0,
    superseded: 0,
    reserved: 0,
    clipboard: 0,
    inputFailed: 0,
    caretFallback: 0,
    // H2 fix design rev2 (D1.2): carets kept by the rendered-difference rule.
    caretDiff: 0,
    // H2 fix design rev2 (D3.3): refused Cut or Copy, refused expanded deletions, guarded deletions.
    clipboardRefused: 0,
    deleteRefused: 0,
    deletes: 0,
    // H2 fix design rev2 (D6.1): input refused while abandoned (its endpoint needs a render).
    abandonRefused: 0,
  }
  // Task 733 / 036 (step C, fix design 2.3, 2.6): the logical text `L` of the replay, live from the move
  // until every group rendered and every replay operation is acknowledged; the publisher it hands to
  // delta-sync, and the delta publisher's replay operations.
  let replayLogical:
    | {
        state: ReplayTarget
        /** Per group: newlines of its target bytes minus newlines of its expected old bytes. */
        lines: Int32Array
        /** The captured intent of the input in flight (2.3), in rendered offsets. */
        intent: InputIntent | undefined
        /** The group of the caret intent (rendered first, 2.4 step 3). */
        caretGroup: number
        /** The document has a `[toc]` (a heading change is unbounded, 2.8). */
        hasToc: boolean
        /** The move is a Redo: a caret inside a hunk lands at its end (H2 fix design rev2, D1.1). */
        isRedo: boolean
      }
    | undefined
  let replaySync: ReplaySync | undefined
  // Task 733 / 036 (E2, fix design 3.6): the replay deltas posted and not acknowledged, with the proof
  // their reapplication needs after a refusal; and the recovery that renders the host text (E).
  let recoveryJournal: RecoveryOp[] = []
  let recovery:
    | {
        target: string
        epoch: number
        refusedEpoch: number
        /**
         * `target` and the model text agree up to here, a top-level boundary of both, and over the last
         * `tail` characters, which start at a top-level boundary of both (S3 review point 3).
         */
        done: number
        tail: number
        /** S4 repair (fix 4): the unit start the step last went back to (once per start). */
        realignedAt: number
        ops: RecoveryOp[]
        whole: (text: string) => void
        frame: number | undefined
        /** 036 core C2 (R31.2, R32.2): the budget owner token, and the end mark of a cancelled run. */
        token: number
        cancelled: boolean
        /** 036 core C3 (L1): the previous frame of this run was a skip. */
        yieldedLast: boolean
      }
    | undefined
  const recoveryCounts = {
    started: 0,
    atomics: 0,
    whole: 0,
    /** H2 fix design rev2 (S3 review point 3): a single unit chunk above `RECOVERY_CHUNK` characters. */
    oversize: 0,
    /** A chunk the plan refused, grown by one segment per side. */
    grown: 0,
    /** S4 repair (fix 6): a frame's first recovery atomic that did not fit and ran alone. */
    forced: 0,
    /** S4 repair (fix 4): a host block crossed the aligned tail, so the tail was dropped. */
    tailDropped: 0,
    /** S4 repair (fix 4): a step went back to the start of the rendered unit holding `done`. */
    realigned: 0,
    reapplied: 0,
    kept: 0,
    /** 036 core C3 (L1): recovery frames skipped for an input. */
    yielded: 0,
    /** 036 core (Q-267): a webview-only write the core could not place; a count only. */
    lateWriteUnpublished: 0,
    /** 036 core C2 (R5.1): the synchronous build a disposal ran to prove a pending reapplication (ms). */
    disposeBuildMs: 0,
  }
  /**
   * 036 core C2 (R4.2, R5.1): the refused edits of a whole recovery, kept until the rebuilt model proves
   * them (`target` is the exact text the whole render was given). Filled by the whole recovery (C5).
   */
  let pendingReapply:
    | {
        refusedEpoch: number
        epoch: number
        target: string
        ops: RecoveryOp[]
      }
    | undefined
  // 036 core C2 (R2.3): the epoch in which a genuine record first dirtied the model; cleared when the
  // model holds no dirty unit after a publication, and at teardown.
  let userEditEpoch: number | undefined
  // 036 core C2: `flushUserEdits` runs once at a time (a publication can report a mode change).
  let flushing = false
  // 036 core C3 (L1): a user input since the last replay or recovery frame read it, and its time. The
  // replay start keeps it, so the key that starts a replay makes its first frame yield.
  let inputSeen = false
  let inputAt = Number.NEGATIVE_INFINITY
  // 036 core C4 (R34.1): the last absorb costs at observer delivery (end-to-end runs only).
  const deliveryAbsorbMs = new Float64Array(DELIVERY_SAMPLES)
  let deliveryAbsorbAt = 0

  /** Task 733 / 036 (T0): whether a boundary unit of `range` is opaque (end-to-end trace only). */
  const nearestUnit = (node: Node) => {
    let el: Element | null = node instanceof Element ? node : node.parentElement
    while (el) {
      const unit = model?.unitOf(el as HTMLElement)
      if (unit) return unit
      el = el.parentElement
    }
    return undefined
  }
  /**
   * 036 core C4 (M1, R1.1): a unit whose sync can publish: proven (an unproven clean single element is
   * proven now, before the write, as the pre-touch proof does); and no pending group left inside it after
   * the endpoint render, so the change translates to `L`.
   */
  const publishableUnit = (node: Node): boolean => {
    const unit = nearestUnit(node)
    if (!unit || !model) return false
    // Q-269: an unproven unit is admitted only when it is proven now, before the write, against its
    // unchanged bytes (the proof the sync would need); a dirty or multi-element one is refused.
    if (
      unit.proof === 'none' &&
      !unit.explicit &&
      !unit.dirty &&
      unit.members.length === 1
    )
      model.prove(unit)
    if (unit.proof !== 'proven') return false
    return !pendingIn(unit.start, unit.end)
  }
  /**
   * 036 core C4 (M1): during a replay or a recovery, whether the input at `range` can be posted with its
   * bytes. False during a recovery (S3 decision 1), on an abandoned replay without its logical text, or
   * when an endpoint unit cannot publish. True outside both. Allocates nothing on success.
   */
  const replayAcceptsInput = (range: {
    startContainer: Node
    endContainer: Node
  }): boolean => {
    if (recovery) return false
    if (abandonedReplay !== undefined && replayLogical === undefined)
      return false
    if (!replayLogical) return true
    if (!model || !live()) return false
    return (
      publishableUnit(range.startContainer) &&
      publishableUnit(range.endContainer)
    )
  }
  /** 036 core C4 (M1): an input refused before it reached the DOM; the key or action has no effect. */
  const refuseReplayInput = (event: Event): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
    replayCounts.replayInputRefused++
  }
  const boundaryOpaque = (range: Range): boolean =>
    model !== undefined &&
    (nearestUnit(range.startContainer)?.proof === 'opaque' ||
      nearestUnit(range.endContainer)?.proof === 'opaque')

  /** Task 733 / 036 (T0): the schedule as the pre-touch listeners see it, recording each outcome. */
  const recordingProofs = (
    inner: Pick<UnitSchedule, 'proveForSelection'>,
  ): Pick<UnitSchedule, 'proveForSelection'> => ({
    proveForSelection(range) {
      const result = inner.proveForSelection(range)
      touchedProof =
        result === 'fallback'
          ? 'unproven'
          : boundaryOpaque(range)
            ? 'opaque'
            : 'proven'
      return result
    },
  })

  let buildFrame: number | undefined
  const listeners = new Set<(change: UnitsChange) => void>()
  /** What the observer batches marked since the last emitted change (merged per animation frame). */
  // Task 733 / 012-1: `spun` holds the spun top-level elements of the pending batches. One object for
  // the session; the spun set is reused, never reallocated.
  const pending: {
    changed: Set<Unit<HTMLElement>> | undefined
    structure: Set<'root' | Unit<HTMLElement>> | undefined
    spun: Set<HTMLElement>
    inserted: Set<HTMLElement>
    rootUnexplained: boolean
  } = {
    changed: undefined,
    structure: undefined,
    spun: new Set(),
    inserted: new Set(),
    rootUnexplained: false,
  }
  /**
   * Task 733 / 012-1: what the feed frames reported since the last sync. The next sync writes these
   * units, so it reports them again (scoped) instead of a whole change. Reused, never reallocated.
   */
  const kept = {
    changed: new Set<Unit<HTMLElement>>(),
    structure: new Set<'root' | Unit<HTMLElement>>(),
    spun: new Set<HTMLElement>(),
    inserted: new Set<HTMLElement>(),
    rootUnexplained: false,
  }
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
    // Task 733 / 017: the index follows synced text (a mutation change precedes the sync of its bytes).
    if (definitionIndex && change.cause !== 'mutation')
      definitionIndex.onUnitsChange(change)
    for (const listener of Array.from(listeners)) listener(change)
  }

  const cancelFeedFrame = (): void => {
    if (feedFrame !== undefined) deps.cancelAnimationFrame(feedFrame)
    feedFrame = undefined
    pending.changed = undefined
    pending.structure = undefined
    pending.spun.clear()
    pending.inserted.clear()
    pending.rootUnexplained = false
  }

  const dropKept = (): void => {
    kept.changed.clear()
    kept.structure.clear()
    kept.spun.clear()
    kept.inserted.clear()
    kept.rootUnexplained = false
  }

  /** Resolves the pending sets (and `withKept`, the kept ones) against the model as it is now: removed units are dropped. */
  const takePending = (
    cause: UnitsChange['cause'],
    withKept?: BatchSets,
  ): UnitsChange => {
    // Resolved before the cancel: it clears the reused spun set.
    const resolved = resolveBatch(pending, modelRoot(), withKept)
    cancelFeedFrame()
    return { cause, ...resolved }
  }

  const emitWhole = (cause: UnitsChange['cause']): void => {
    cancelFeedFrame()
    dropKept()
    emit({ cause, whole: true, changed: [], structural: [], scopes: NO_SCOPES })
  }

  /** The change a whole-text publication's sync reports: a fallback cannot be scoped. */
  const emitPublished = (result: SyncResult): void => {
    if (result.kind !== 'fallback' && result.changes.length > 0) {
      emitSync()
      return
    }
    cancelFeedFrame()
    dropKept()
    emit({
      cause: 'sync',
      whole: result.kind === 'fallback',
      changed: [],
      structural: [],
      scopes: NO_SCOPES,
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
    dropKept()
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
      scopes: appliedScopes(rendered, changed, table !== undefined),
    })
  }

  /** A sync wrote changes: the units marked since the last change are the changed ones. */
  const emitSync = (): void => {
    const spinOnly = spinOnlyRoot(pending) || spinOnlyRoot(kept)
    // Task 733 / 012-1: the units a feed frame already reported are the ones this sync wrote.
    const change = takePending('sync', kept)
    dropKept()
    const known =
      change.changed.length > 0 || change.structural.length > 0 || spinOnly
    // A sync with changes that no batch explains cannot be scoped: consumers run their full pass.
    emit(
      known || change.whole
        ? change
        : { ...change, whole: true, scopes: NO_SCOPES },
    )
  }

  /** Keeps what the feed frame reports until the sync that writes it. */
  const keepPending = (): void => {
    for (const unit of pending.changed ?? []) kept.changed.add(unit)
    for (const scope of pending.structure ?? []) kept.structure.add(scope)
    for (const top of pending.spun) kept.spun.add(top)
    addAll(kept.inserted, pending.inserted)
    if (pending.rootUnexplained) kept.rootUnexplained = true
  }

  /** The frame callback is one closure for the session: a batch allocates no function. */
  const feedFrameDone = (): void => {
    // A cancelled frame (a sync took the pending sets, or the session went off) reports nothing.
    if (feedFrame === undefined) return
    feedFrame = undefined
    // Re-read after the frame: a model that went off meanwhile has nothing to report.
    if (!model || !live()) {
      cancelFeedFrame()
      dropKept()
      return
    }
    keepPending()
    emit(takePending('mutation'))
  }

  const capture = createUnitCapture({
    model: () => model,
    root: () => modelRoot() ?? undefined,
    drain: () => dom?.drain(),
    // Task 733 / 015 (D-7): this capture is IR-shaped; the Source model has its own port below (019).
    ready: () =>
      live() &&
      servesBuiltMode() &&
      builtMode !== 'sv' &&
      // Task 733 / 036 (step C, 2.7): typing during a replay is its own undo entry.
      ((!awaitingNow() && !stale) || replayLogical !== undefined),
    // A model that is off observes nothing, so the unit engine could not capture an edit and its Undo
    // would do nothing: the old engine holds the history then (an IR re-entry before the first post's
    // answer, a deferred edit view before its build, a permanent off). Only a rebuild over the same
    // DOM keeps the unit engine: what is pending is held as one step of the next capture (`hold`).
    claimable: () =>
      (serving() && builtMode !== 'sv') || buildFrame !== undefined,
    vditor: () =>
      (win as unknown as { vditor?: { vditor?: unknown } }).vditor?.vditor,
    mode: () =>
      builtMode === undefined || builtMode === 'sv' ? 'ir' : builtMode,
    // Task 733 / 036 (F8): a host update or an abandoned replay stops a sliced restore.
    sliceAborted: () => exactAbortSlices,
    requestFrame: (callback) => {
      deps.requestAnimationFrame(callback)
    },
  })

  // Task 733 / 036: the IR port with the exact-replay join (built on first use; see `slicedPort`).
  let exactCapturePort: HistoryModelPort | undefined

  /** Task 733 / 019 (D-7, Q-154): the history port of the Source model, served while it is built. */
  const sourceCapture = createSourceHistoryCapture({
    model: () => (builtMode === 'sv' ? model : undefined),
    root: () =>
      builtMode === 'sv' ? (deps.getSourceRoot?.() ?? undefined) : undefined,
    drain: () => dom?.drain(),
    ready: () =>
      live() &&
      servesBuiltMode() &&
      builtMode === 'sv' &&
      !awaitingNow() &&
      !stale,
    claimable: () =>
      (serving() && builtMode === 'sv') || buildFrame !== undefined,
  })

  /** Both history captures lose what they hold (the text or the DOM behind them is gone). */
  const invalidateCaptures = (): void => {
    capture.invalidate()
    sourceCapture.invalidate()
  }

  /** One mutation change per animation frame, after the last batch of the frame. */
  const onBatch = (
    changed: ReadonlySet<Unit<HTMLElement>>,
    structure: ReadonlySet<'root' | Unit<HTMLElement>>,
    inserted?: ReadonlySet<HTMLElement>,
  ): void => {
    // 036 core C2 (R2.3): own and quiet writes never reach `onBatch`, so this batch is a genuine edit.
    if (userEditEpoch === undefined && host) userEditEpoch = host.epoch
    // The history capture reads the units before a sync can overwrite their HTML.
    if (builtMode === 'sv') sourceCapture.onBatch(changed, structure)
    else capture.onBatch(changed, structure)
    pending.changed = mergeBatch(pending.changed, changed)
    if (inserted) addAll(pending.inserted, inserted)
    pending.structure = mergeBatch(pending.structure, structure)
    if (structure.has('root')) {
      // Read inside the batch: the adapter's spun set belongs to the batch it is reporting.
      const spun = dom?.takeSpun()
      if (spun) for (const top of spun) pending.spun.add(top)
      else pending.rootUnexplained = true
    }
    if (feedFrame !== undefined) return
    feedFrame = deps.requestAnimationFrame(feedFrameDone)
  }

  /**
   * Task 733 / 017: re-renders a dependent of a definition change in place (its element keeps its
   * identity) as a quiet write: no unit turns dirty, nothing is published. false when the unit is gone,
   * dirty, or the spin does not give back one element of the same tag.
   */
  const rerenderUnit = (
    built: TextModel<HTMLElement>,
    unitDom: ReturnType<typeof createUnitDom>,
    root: HTMLElement,
    el: HTMLElement,
    context: DefinitionContext | undefined,
  ): boolean => {
    if (model !== built || !el.isConnected) return false
    const unit = built.unitOf(el)
    const lute = deps.getLute() as unknown as SpinLute | null
    if (!unit || unit.dirty || !lute) return false
    let html: string | undefined = lute.SpinVditorIRDOM(
      el.outerHTML + (context?.html ?? ''),
    )
    if (context)
      html = stripDefinitionContext(html, context, (label) =>
        definitionIndex?.footnoteOf(label),
      )
    if (html === undefined) return false
    const template = root.ownerDocument.createElement('template')
    template.innerHTML = html
    const fresh = template.content.firstElementChild
    if (
      !fresh ||
      template.content.children.length !== 1 ||
      fresh.tagName !== el.tagName
    )
      return false
    writeQuietly(() => {
      el.innerHTML = fresh.innerHTML
    })
    unit.html = unitDom.html(unit.kind, el)
    emit({
      cause: 'sync',
      whole: false,
      changed: [toLiveUnit(unit, root)],
      structural: [],
      scopes: [el],
    })
    return true
  }

  /** Task 733 / 017: the definition index of a live IR model (task 017 section 6.3). */
  const createIndex = (
    built: TextModel<HTMLElement>,
    unitDom: ReturnType<typeof createUnitDom>,
    root: HTMLElement,
  ): DefinitionIndex =>
    createDefinitionIndex({
      units: () => session.liveUnits(),
      bytesOf: (el) => {
        const unit = built.unitOf(el)
        return unit ? built.text.slice(unit.start, unit.end) : undefined
      },
      // Task 733 / 021: the kind of the unit whose element is `el` (a row has no live kind).
      kindOf: (el) => {
        const unit = built.unitOf(el)
        if (!unit || (unit.el ?? unit.members[0]) !== el || unit.kind === 'row')
          return undefined
        return unit.kind
      },
      rerender: (el, context) =>
        rerenderUnit(built, unitDom, root, el, context),
      setFootnoteTooltip: (el, label, tooltip) => {
        for (const sup of el.querySelectorAll(
          'sup[data-type="footnotes-ref"]',
        )) {
          const own = (sup.getAttribute('data-footnotes-label') ?? '').replace(
            /^\^/u,
            '',
          )
          if (normalizeLabel(own) === label)
            sup.setAttribute('aria-label', tooltip)
        }
      },
      scheduler: backgroundSchedulerOf(win),
    })

  /**
   * 036 core C2 (R2.3): `'user'` (disposal, a mode switch) first publishes the outstanding user edits;
   * `'host'` (a host write rebuilds the DOM: `buildSoon`, `attempt`, a host write outcome, an internal
   * failure) never flushes, since its pending records are the host's own write.
   */
  const teardown = (cause: 'user' | 'host'): void => {
    if (cause === 'user') flushUserEdits()
    // R33.4: the replay run ends first (its frame cancelled, its promise settled, its token finished).
    if (replayRun) endRun(replayRun, false)
    endLogical()
    cancelRecovery()
    userEditEpoch = undefined
    recoveryJournal = []
    if (restartTimer !== undefined) deps.clearTimeout(restartTimer)
    restartTimer = undefined
    removeListeners?.()
    removeListeners = undefined
    schedule?.stop()
    schedule = undefined
    definitionIndex?.dispose()
    definitionIndex = undefined
    dom?.detach()
    dom = undefined
    model = undefined
    cancelFeedFrame()
    dropKept()
    prediction = undefined
    preTouchFallback = false
    exactSequences.clear()
    stale = false
    // Task 733 / 022: ending the wait ends the hold; nothing is published for it.
    held = undefined
    keptBeforePost = undefined
    endExactWait()
  }

  const cancelBuild = (): void => {
    if (buildFrame !== undefined) deps.cancelAnimationFrame(buildFrame)
    buildFrame = undefined
  }

  /**
   * Task 733 / 015 (D-1, D-2): the Source model over Vditor's Source DOM. Its units are the `data-block`
   * divs, proven by text equality at attach (no Lute, no proof schedule, no history capture: Source
   * history stays on the old engine until 015-I4).
   */
  const attemptSource = (): void => {
    const root = deps.getSourceRoot?.() ?? null
    if (!host || !domComplete || deps.isStreaming() || !root) {
      offReason = 'not-mounted'
      return
    }
    builtMode = 'sv'
    modelLute = undefined
    const sourceDom = createSourceUnitDom(root, { onBatch })
    const built = createTextModel(sourceDom, scanSourceChunks)
    built.build(host.text)
    model = built
    if (built.state !== 'live') {
      offReason = built.offReason ?? 'not-mounted'
      return
    }
    dom = sourceDom
    sourceDom.attach(built)
    // The Source DOM as built is the base of the first Source history capture (019).
    sourceCapture.invalidate()
    confirmed = true
    emitWhole('build')
  }

  /** Task 733 / 017: in IR the scan adds the definition kinds; the ToC option decides what `[toc]` is. */
  const scanFor = (
    mode: UnitMode,
    root: HTMLElement,
  ): ((text: string) => MovableBlock[]) => {
    if (mode !== 'ir' || !DEFINITION_UNITS) return scanMovableBlocks
    const toc = tocEnabledFor(deps, root)
    return (text: string) => scanModelBlocks(text, { toc })
  }

  /** Builds the model from the held host text if every precondition holds; otherwise stays off. */
  // Task 733 / 036 (step D, 2.7): a replay write stamps the page context of its nodes inside the write;
  // returns the release, or undefined when no page context is installed over the root.
  const drainPageContext = (
    unitDom: Pick<UnitDomControl, 'addWriteDrain'>,
    root: HTMLElement,
  ): (() => void) | undefined => {
    const drain = webviewContextDrainFor(root)
    return drain ? unitDom.addWriteDrain?.(drain) : undefined
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the preconditions, the build, the schedule, the definition index and the pending reapplication are one build
  const attempt = (): void => {
    cancelBuild()
    teardown('host')
    confirmed = false
    const mode = servedMode()
    if (!mode) {
      offReason = 'mode'
      return
    }
    if (mode === 'sv') {
      attemptSource()
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
    // Task 733 / 013: the pair of the served mode (WYSIWYG maps VditorDOM2Md / Md2VditorDOM onto it).
    const boundLute: UnitLute = unitLuteOf(lute as unknown as ModeLute, mode)
    builtMode = mode
    modelLute = boundLute
    const unitDom = createUnitDom(root, boundLute, {
      mode,
      onBatch,
      // 036 core C4 (R34.1): each user task's mutations during a replay post at their observer delivery.
      onDelivered: onReplayDelivered,
      // The post-render steps of an apply (previews, captions, outline) need the inner editor.
      vditor: () =>
        (win as unknown as { vditor?: { vditor?: unknown } }).vditor?.vditor,
    })
    builtScan = scanFor(mode, root)
    const built = createTextModel(unitDom, builtScan)
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
        servesBuiltMode() &&
        !deps.isPreviewShowing() &&
        model?.state === 'live',
      drain: () => unitDom.drain(),
      requestAnimationFrame: (cb) => deps.requestAnimationFrame(cb),
      cancelAnimationFrame: (handle) => deps.cancelAnimationFrame(handle),
      now: () => deps.now(),
      setTimeout: (cb, ms) => deps.setTimeout(cb, ms),
      clearTimeout: (handle) => deps.clearTimeout(handle),
      // Task 733 / 036 (step C, 2.6): the pre-touch skips units of pending replay groups.
      replayPending: (unit) => pendingIn(unit.start, unit.end),
      // Task 733 / 036 (step D, 4.3): the proof lane runs in what remains of the replay budget.
      replayAccount: replayBudget,
    })
    schedule = unitSchedule
    const stopWatching = capture.watch(root)
    const stopPreTouch = installPreTouchListeners({
      root,
      // Task 733 / 036 (T0): end-to-end runs record each proof's outcome for the publication trace.
      schedule: deps.e2e ? recordingProofs(unitSchedule) : unitSchedule,
      isComposing: () => deps.isComposing(),
      // The next whole-text publication is a fallback (reason in the schedule's stats).
      onFallback: () => {
        preTouchFallback = true
      },
    })
    const stopContextDrain = drainPageContext(unitDom, root)
    removeListeners = () => {
      stopWatching()
      stopPreTouch()
      stopContextDrain?.()
    }
    confirmed = true
    unitSchedule.start()
    if (mode === 'ir' && DEFINITION_UNITS)
      definitionIndex = createIndex(built, unitDom, root)
    emitWhole('build')
    // 036 core C5 (R3.2): the whole recovery's kept ops, against the confirmed rebuilt model.
    if (pendingReapply) finishPendingReapply()
  }

  /** A `setValue` rebuild finishes in later microtasks: build on the next animation frame (OQ-5). */
  const buildSoon = (): void => {
    cancelBuild()
    // The same DOM is described by the next model: what is pending stays one step of the next capture.
    capture.hold()
    teardown('host')
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

  const clearExactWatchdog = (): void => {
    if (exactWatchdog !== undefined) deps.win.clearTimeout(exactWatchdog)
    exactWatchdog = undefined
  }
  /** Task 733 / 036: ends the exact wait (an answer handled, a host text, a refusal or teardown). */
  const endExactWait = (): void => {
    if (exactPending !== undefined || exactAbandoned) exactAbortSlices = true
    // H2 fix design rev2 (D6.1): the logical text an abandon kept ends with the abandoned wait.
    if (exactAbandoned) endLogical()
    clearExactWatchdog()
    exactPending = undefined
    exactReply = undefined
    exactAbandoned = false
    exactReplay = undefined
    abandonedReplay = undefined
  }
  /**
   * The apply transaction of `applyText` (handoff 2.4). Task 733 / 036 (step B): `replay` writes one replay
   * group: the history stacks already moved, so the history capture takes no snapshot, and the render runs
   * inside the per-write drain (fix design 2.7): the write's own records reach no model handler.
   */
  function applyNow(
    changes: readonly TextChange[],
    replay: boolean,
    keep = false,
  ): { outcome: ApplyOutcome; rendered?: readonly HostUnit<HTMLElement>[] } {
    const prepared = prepareApply(changes)
    if (!('commit' in prepared)) return prepared
    return commitPrepared(prepared, replay, keep)
  }

  /**
   * The checked half of `applyNow`: the plan and its replacement are built and checked, nothing is
   * written (H2 fix design rev2, D3.3 render preflight). `commitPrepared` writes exactly this one.
   */
  function prepareApply(
    changes: readonly TextChange[],
  ): { outcome: ApplyOutcome } | PreparedApply {
    if (!model || !dom) return { outcome: APPLY_OFF }
    // A composition owns the DOM under the caret.
    if (deps.isComposing()) return { outcome: applyFallback('dirty-overlap') }
    const current = model
    const unitDom = dom
    unitDom.drain()
    const planned = current.planApply(changes)
    if (planned.kind === 'fallback') return { outcome: planned }
    const { plan } = planned
    const rows = plan.tableRows?.[0]
    const replace = rows
      ? rows.rows.map(
          (r) => rows.table.children[r].members[0].parentElement as HTMLElement,
        )
      : plan.removed.flatMap((unit) => unit.members)
    if (!unitDom.prepareRender)
      return { outcome: applyFallback('lute-not-ready') }
    const commit = unitDom.prepareRender(plan.sources, replace)
    if (!commit) return { outcome: applyFallback('window-without-kind') }
    return { model: current, unitDom, plan, rows, replace, commit }
  }

  /** Writes a prepared apply: the history capture, the render, the model commit and its report. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the capture, render, kind check, commit and report are one transaction (handoff 2.4)
  function commitPrepared(
    prepared: PreparedApply,
    replay: boolean,
    keep: boolean,
  ): { outcome: ApplyOutcome; rendered?: readonly HostUnit<HTMLElement>[] } {
    const { model: current, unitDom, plan, rows, replace, commit } = prepared
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
    if (!replay) capture.onBatch(new Set(), scopes)
    // H2 fix design rev2 (D1.1): the selection is read against the elements this render replaces (a row
    // plan's live rows, else the removed units' elements), before they leave the document.
    if (keep) keepSelectionAcross(replace)
    const rendered =
      replay && unitDom.writeOwn
        ? unitDom.writeOwn(() => commit.commit())
        : commit.commit()
    // `render` writes nothing when a built element has another kind than its source.
    if (
      rendered.length !== plan.sources.length ||
      rendered.some((unit, i) => unit.kind !== plan.sources[i].kind)
    )
      return { outcome: applyFallback('window-without-kind') }
    // The capture sees the replacement while the model still lists the removed units (handoff 2.4).
    if (!replay) unitDom.drain()
    current.commitApply(plan, rendered)
    // Task 733 / 036 (step B, 4.3): a replay write is reported once per frame, with the other atomics of
    // its frame (`emitReplayFrame`); a pending genuine feed frame is kept.
    if (replay)
      replayFrameWrites.push({ rendered, table: rows?.table, neighbours })
    else emitApplied(rendered, rows?.table, neighbours)
    restartSoon()
    return { outcome: APPLIED, rendered }
  }

  /**
   * Task 733 / 036 (F8): gives the replay up; the host's resync `update` ends the guard. H2 fix design rev2
   * (D6.1): rendering stops, but the logical text stays with its frozen groups, so input is still posted
   * as replay operations of the old epoch (the host keeps each one as a recovery entry); the abandoned
   * operation is queried every 5 s until a newer epoch arrives.
   */
  const abandonExact = (sequence: number): void => {
    if (exactPending !== sequence) return
    clearExactWatchdog()
    exactPending = undefined
    exactReply = undefined
    awaited = undefined
    exactAbandoned = true
    replayOwnership = undefined
    noteSaveUnproven()
    exactAbortSlices = true
    // B0: the abandon names the operation, so a late one cannot reset a newer replay (3.2).
    const replay = exactReplay
    exactReplay = undefined
    if (!replay) {
      endLogical()
      return
    }
    abandonedReplay = { epoch: replay.epoch, replayOp: replay.replayOp }
    postAbandon()
    armAbandonQuery()
  }
  const postHostStateQuery = (abandoned: {
    epoch: number
    replayOp: number
  }): void => {
    deps.postReplay?.({
      command: 'host-state-query',
      requestId: `replay-${abandoned.epoch}-${abandoned.replayOp}`,
    })
  }
  /**
   * H2 fix design rev2 (D6.1): the abandoned operation's status; true when it was one. A refused or ended
   * one has a resync whose `update` did not arrive: the host state replaces it. `applied` does not tell:
   * the host also answers it for an ended epoch inside its accepted prefix, so it asks for the host state
   * and probes the epoch with an operation that never exists (an ended epoch answers `ended`, the current
   * one `unknown`). Any other state means the epoch did not end, so the abandon itself was lost: it is
   * posted again (the host resyncs once per epoch).
   */
  const answerAbandonedStatus = (message: {
    epoch: number
    replayOp: number
    state: string
  }): boolean => {
    const abandoned = abandonedReplay
    if (
      !abandoned ||
      !exactAbandoned ||
      message.epoch !== abandoned.epoch ||
      (message.replayOp !== abandoned.replayOp &&
        message.replayOp !== ABANDON_PROBE_OP)
    )
      return false
    if (message.state === 'refused' || message.state === 'ended')
      postHostStateQuery(abandoned)
    else if (message.state === 'applied') {
      postHostStateQuery(abandoned)
      deps.postReplay?.({
        command: 'replay-query',
        epoch: abandoned.epoch,
        replayOp: ABANDON_PROBE_OP,
      })
    } else postAbandon()
    return true
  }
  const postAbandon = (): void => {
    const abandoned = abandonedReplay
    if (abandoned)
      deps.postReplay?.({
        command: 'replay-abandon',
        epoch: abandoned.epoch,
        replayOp: abandoned.replayOp,
      })
  }
  /** H2 fix design rev2 (D6.1, 3.5): the abandoned operation's status every 5 s, until the resync lands. */
  const armAbandonQuery = (): void => {
    clearExactWatchdog()
    exactWatchdog = deps.win.setTimeout(() => {
      const abandoned = abandonedReplay
      if (!abandoned || !exactAbandoned) return
      deps.postReplay?.({
        command: 'replay-query',
        epoch: abandoned.epoch,
        replayOp: abandoned.replayOp,
      })
      armAbandonQuery()
    }, EXACT_WATCHDOG_MS)
  }
  /** Task 733 / 036 (B0, 3.5): asks for the awaited operation's status every 5 s instead of abandoning. */
  const armReplayQuery = (): void => {
    clearExactWatchdog()
    exactWatchdog = deps.win.setTimeout(() => {
      const replay = exactReplay
      if (!replay || exactPending === undefined) return
      deps.postReplay?.({
        command: 'replay-query',
        epoch: replay.epoch,
        replayOp: replay.replayOp,
      })
      armReplayQuery()
    }, EXACT_WATCHDOG_MS)
  }
  /** Task 733 / 036 (B0, 3.7): the acknowledged move ends the wait with the record's target text. */
  const answerReplay = (
    epoch: number,
    replayOp: number,
    targetOf: ((requestId: string) => string | undefined) | undefined,
  ): boolean => {
    const replay = exactReplay
    if (
      !replay ||
      exactPending === undefined ||
      epoch !== replay.epoch ||
      replayOp < replay.replayOp
    )
      return false
    const target = targetOf?.(replay.requestId)
    // No target to show: the host bytes are needed; one resync brings them.
    if (target === undefined) {
      abandonExact(exactPending)
      return false
    }
    return answerExact(normalizeEol(target), epoch)
  }
  /** Task 733 / 036 (F8): the restore-made flags are dropped; the host bytes come with the answer. */
  const settleRestored = (): void => {
    // Step C: typing of the replay is published first; the flags are cleared after it.
    if (replayLogical) absorbReplay(postLogicalDelta)
    dom?.drain()
    if (model && live()) model.markPublishedWhole()
  }
  const finishExactReply = (reply: {
    content: string
    epoch: number
  }): void => {
    const engine =
      replayRendered !== undefined && replayRendered === exactPending
    replayRendered = undefined
    endExactWait()
    settleRestored()
    // Task 733 / 036 (step B, 2.5): every group rendered and checked, so the model text is the target: the
    // acknowledgement takes the host text and epoch with no rebind and no whole change.
    // Step C (2.6): typing during the replay is in `L`, so the model text then is `L`, not the target.
    if (
      engine &&
      model?.state === 'live' &&
      (model.text === reply.content || replayLogical?.state.pending() === 0)
    ) {
      host = { text: model.text, epoch: reply.epoch }
      stale = false
      confirmed = true
      schedule?.restart()
      maybeEndLogical()
      return
    }
    endLogical()
    if (engine) replayCounts.rebinds++
    finishAnswer(reply.content, reply.epoch)
  }
  /**
   * Task 733 / 036 (step B, fix design 2.4-2.5): renders one pending group of the replay as one atomic: the
   * group's expected old bytes are checked against the model text, its target bytes are written by the
   * apply transaction inside the per-write drain, and the result is checked against the target. A window
   * that only references definitions renders through the window context (Q-G, 2.8). Returns 'retry' when
   * the group cannot render in this frame (a composition), 'unbounded' when it cannot render
   * incrementally, 'mismatch' when the model no longer holds the expected bytes.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: check, apply, the definition-context retry and the result check are one atomic
  function renderGroup(
    state: ReplayTarget,
    group: number,
    hasToc: boolean,
  ): 'rendered' | 'retry' | 'unbounded' | 'mismatch' {
    const current = model
    if (!current || !dom) return 'mismatch'
    dom.drain()
    if (!state.checkOld(current.text, group)) return 'mismatch'
    const r = { from: 0, to: 0 }
    const t = { from: 0, to: 0 }
    state.rangeR(group, r)
    state.rangeT(group, t)
    const insert = state.target.slice(t.from, t.to)
    // Q-G (2.8): a `[toc]` depends on every heading, so a heading change in a document with one is unbounded.
    if (hasToc && touchesHeading(current.text, r.from, insert)) {
      noteRefusal('toc-heading', group, r, current)
      return 'unbounded'
    }
    const changes = [{ from: r.from, to: r.to, insert }]
    keptSelection = undefined
    // H2 fix design rev2 (D5.1): a group is unsupported only at plan time (the plan or its render
    // preflight refuses, nothing written); a failure once the write began is a mismatch, never retried.
    let prepared = prepareApply(changes)
    let contexts = false
    if (
      !('commit' in prepared) &&
      prepared.outcome.kind === 'fallback' &&
      prepared.outcome.reason === 'dependent-construct' &&
      definitionIndex
    ) {
      prepared = withDefinitionReferences(() => prepareApply(changes))
      contexts = true
    }
    if (!('commit' in prepared)) {
      const { outcome } = prepared
      if (
        outcome.kind === 'fallback' &&
        outcome.reason === 'dirty-overlap' &&
        deps.isComposing()
      )
        return 'retry'
      noteRefusal(
        outcome.kind === 'fallback' ? outcome.reason : 'off',
        group,
        r,
        current,
      )
      return 'unbounded'
    }
    // S4 repair (fix 2): what the commit must leave around the range, read before it writes.
    const oldLength = current.text.length
    const before = r.from > 0 ? current.text.charCodeAt(r.from - 1) : -1
    const after = r.to < oldLength ? current.text.charCodeAt(r.to) : -1
    // S4 repair (fix 1): an exception once the write began is a mismatch: the frame settles, nothing retries.
    try {
      const applied = commitPrepared(prepared, true, true)
      if (applied.outcome.kind !== 'applied') {
        keptSelection = undefined
        return 'mismatch'
      }
      const rerendered =
        !contexts || rerenderWithContexts(current, applied.rendered ?? [])
      // H2 fix design rev2 (D1.1): the endpoints in the replaced window are put back once, after every
      // element of this atomic is written (the definition context renders replace them again).
      restoreKeptSelection(
        r.from,
        r.to - r.from,
        insert.length,
        replayLogical?.isRedo ?? false,
      )
      // D5.1: the context render runs after the commit: its failure is a mismatch (stop, no retry).
      if (!rerendered) return 'mismatch'
      // The model text holds the group's target bytes at its range (2.3), with the expected length and
      // the same neighbouring characters (an empty insertion proves nothing by itself).
      if (
        !committedExactly(
          current.text,
          r.from,
          insert,
          oldLength - (r.to - r.from),
          before,
          after,
        )
      )
        return 'mismatch'
    } catch {
      keptSelection = undefined
      replayCounts.thrown++
      return 'mismatch'
    }
    state.markRendered(group)
    return 'rendered'
  }

  /**
   * S4 repair (diagnosis 10): the last plan-time refusal of a replay group, kinds and numbers only (no
   * text): the reason, the group, its range length, the kinds of the units its range touches, and the
   * awaited operation. Built only on a refusal.
   */
  function noteRefusal(
    reason: string,
    group: number,
    r: { from: number; to: number },
    current: TextModel<HTMLElement>,
  ): void {
    const kinds: string[] = []
    const units = current.units
    for (
      let at = Math.max(0, unitAtOrBefore(units, r.from) - 1);
      at < units.length;
      at++
    ) {
      if (units[at].start > r.to + 1 && kinds.length > 0) break
      kinds.push(units[at].kind)
      if (kinds.length >= 8) break
    }
    lastRefusal = {
      reason,
      group,
      length: r.to - r.from,
      kinds,
      epoch: exactReplay?.epoch,
      replayOp: exactReplay?.replayOp,
      requestId: exactReplay?.requestId,
      dryRun: keyDryRun,
    }
  }

  /** The line of `from` is an ATX heading, or the inserted text starts one (setext underlines are not read). */
  const touchesHeading = (
    text: string,
    from: number,
    insert: string,
  ): boolean => {
    const lineStart = text.lastIndexOf('\n', from - 1) + 1
    return (
      ATX_HEADING.test(
        text.slice(lineStart, Math.min(text.length, lineStart + 8)),
      ) || insert.includes('\n#')
    )
  }

  /**
   * Task 733 / 036 (Q-G, fix design 2.8): each unit a replay rendered without its definitions renders
   * again through the window context of the definitions it references; footnote references get their
   * document numbers back from the index (`stripDefinitionContext`). false when one cannot.
   */
  const rerenderWithContexts = (
    built: TextModel<HTMLElement>,
    rendered: readonly HostUnit<HTMLElement>[],
  ): boolean => {
    const root = deps.getRoot()
    if (!root || !dom || !definitionIndex) return false
    for (const listed of rendered) {
      const el = listed.members[0]
      const unit = el ? built.unitOf(el) : undefined
      if (!unit) return false
      const context = definitionIndex.contextFor(
        built.text.slice(unit.start, unit.end),
      )
      if (context && !rerenderUnit(built, dom, root, el, context)) return false
    }
    return true
  }

  /** 036 S5.2: counts one route from the engine to the sliced restore; always undefined. */
  const routed = (route: keyof typeof routeCounts): undefined => {
    routeCounts[route]++
    return undefined
  }

  /**
   * 036 S5.2 (S5 design rev 2 section 2): counts the record's dry-run state at an Undo key. A check that
   * yielded to its budget becomes `interrupted`. A record is built only for a state other than a clean
   * completed check.
   */
  function noteDryRunAtKey(requestId: string): HunkCheck | undefined {
    const check = hunkChecks.get(requestId)
    if (check?.state === 'running') check.state = 'interrupted'
    const state = check ? check.state : 'absent'
    keyDryRun = state
    dryRunCounts[`${state}AtKey` as const]++
    if (state !== 'completed' || (check?.refused ?? 0) > 0)
      lastDryRun = {
        state,
        checked: check?.next ?? 0,
        total: check?.total ?? 0,
        refused: check?.refused ?? 0,
        reason: check?.reason,
      }
    return check
  }

  /**
   * Task 733 / 036 (step B): the replay engine of a tagged Undo or Redo with hunks. Undefined when the move
   * cannot replay hunk by hunk (no hunks, `incremental: false`, the model text is not the move's start):
   * the caller takes today's path, counted `replay-whole`. The promise resolves true once every group
   * rendered, false when the replay stopped (a host text, an abandon, an unbounded group or a mismatch).
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the precondition gates, then the per-frame atomic loop under the budget
  function startReplay(side: 'before' | 'after'): Promise<boolean> | undefined {
    const replay = exactReplay
    const sequence = exactPending
    const built = model
    // 036 S5.2: each gate counts its route to the sliced restore (kinds only, no allocation).
    if (!replay) return routed('exactReplay')
    if (sequence === undefined) return routed('exactPending')
    if (!built || !dom) return routed('unavailable')
    if (!live()) return routed('notLive')
    if (builtMode === 'sv') return routed('sv')
    const record = (deps.exactHunksOf ?? exactHistoryHunks)(replay.requestId)
    const hunks = record?.normalized
    if (!hunks?.incremental) return routed('noHunks')
    // 2.2: the idle dry run already knows a group that cannot plan: today's path before the move. A
    // known refusal before an interruption routes as a completed one (S5 review point 3).
    const check =
      side === 'before' ? noteDryRunAtKey(replay.requestId) : undefined
    if (check && check.refused > 0) {
      replayCounts.unplannable++
      return routed('dryRun')
    }
    const start = side === 'before' ? hunks.after : hunks.before
    const target = side === 'before' ? hunks.before : hunks.after
    dom.drain()
    if (built.hasDirty()) return routed('dirty')
    // Step C (2.6, Q-B): a move during a replay supersedes it when its start equals `L` (compared piece
    // by piece); the candidate ranges stay pending only where the rendered text differs from the new
    // target. Otherwise one normalized compare at the key (2.4 step 1).
    const previous = replayLogical
    let state: ReplayTarget | undefined
    if (previous) {
      state = previous.state.logicalEquals(built.text, start)
        ? supersede(
            previous.state,
            built.text,
            target,
            supersedingHunks(hunks, side),
          )
        : undefined
      if (!state) {
        endLogical()
        return routed('supersede')
      }
      replayCounts.superseded++
    } else {
      if (built.text !== start) return routed('startText')
      state = createReplayTarget(
        target,
        built.text.length,
        groupsOfHunks(hunks, side),
        built.text,
      )
      if (!state) return routed('target')
    }
    replayCounts.engine++
    // 036 core C2 (R33.4): a new replay replacing an old one ends the old run first, so its frame and its
    // budget ownership end with it.
    if (replayRun) endRun(replayRun, false)
    let hasToc = false
    for (const unit of built.units) if (unit.kind === 'toc') hasToc = true
    // Step C (2.4 step 3, 2.7): the caret group renders first, then outward from it.
    const lCaret = caretIntentOffset(state, built)
    const order = state.order(lCaret)
    beginLogical(state, order.length > 0 ? order[0] : -1, side === 'after')
    let next = 0
    return new Promise<boolean>((resolve) => {
      const run: ReplayRun = {
        sequence,
        state,
        token: replayBudget.open(),
        frame: undefined,
        stopped: false,
        yieldedLast: false,
        resolve,
      }
      replayRun = run
      let firstSlice = true
      const stop = (ok: boolean): void => endRun(run, ok)
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one frame: the correlation gate, the budgeted atomics and the stop rules
      const frame = (): void => {
        run.frame = undefined
        // 036 core C2 (R32.2): a callback of an ended run does nothing.
        if (run.stopped) return
        // Correlation: the awaited move, its epoch and the built model are re-read every frame.
        if (
          exactAbortSlices ||
          exactPending !== sequence ||
          exactReplay?.epoch !== replay.epoch ||
          model !== built ||
          !live()
        ) {
          stop(false)
          return
        }
        // Step C (2.5): user input is absorbed first, so every atomic sees the model in step with the DOM.
        absorbReplay(postLogicalDelta)
        if (replayLogical?.state !== state || exactPending !== sequence) {
          stop(false)
          return
        }
        // 036 core (R3.5): an end-to-end hold of the first slice (`__vmdeE2EReplayHold`, set and cleared by
        // the spec); unreachable when `e2e` is false. The held frame does no replay work and is not counted.
        if (
          firstSlice &&
          deps.e2e &&
          (win as unknown as { __vmdeE2EReplayHold?: boolean })
            .__vmdeE2EReplayHold === true
        ) {
          run.frame = deps.requestAnimationFrame(frame)
          return
        }
        firstSlice = false
        // 036 core C3 (L1, R31.2): after an input the frame yields, once, and only after a progress frame
        // (so at most 2A + 1 frames for A atomics). A pending caret group renders first, charged as one
        // atomic: that frame counts as progress. A skip calls no `beginFrame`, so carried charges stay.
        if (inputSeen && !run.yieldedLast) {
          inputSeen = false
          run.yieldedLast = true
          const caret = renderCaretGroupCharged(state, hasToc)
          if (caret === 'none') {
            replayCounts.yielded++
            run.frame = deps.requestAnimationFrame(frame)
            return
          }
          run.yieldedLast = false
          if (caret !== 'rendered') {
            stop(false)
            return
          }
          if (state.pending() === 0) {
            stop(true)
            return
          }
          run.frame = deps.requestAnimationFrame(frame)
          return
        }
        run.yieldedLast = false
        replayCounts.frames++
        replayBudget.beginFrame()
        // 036 core C3 (L1): while the last input is recent, one atomic per progress frame.
        const underInput = deps.now() - inputAt < INPUT_PACK_MS
        let done = 0
        let outcome: ReturnType<typeof renderGroup> = 'rendered'
        const range = { from: 0, to: 0 }
        while (next < order.length) {
          if (done > 0 && underInput) break
          const group = order[next]
          // Rendered before an input, or dropped by a user change over it (2.3, 2.6).
          if (!state.isPending(group)) {
            next++
            continue
          }
          state.rangeR(group, range)
          const sizeKb = (range.to - range.from) / 1024
          // H2 fix design rev2 (D5.1): elapsed time only packs frames; a slow valid atomic counts a
          // budget-miss and the replay goes on. S4 repair (fix 6): every atomic passes admission; the
          // frame's first one runs alone when it does not fit, counted, so a replay always moves.
          if (!replayBudget.admit('leaf', sizeKb)) {
            if (done > 0) break
            replayCounts.forced++
          }
          outcome = replayBudget.atomic('leaf', sizeKb, () =>
            renderGroup(state, group, hasToc),
          )
          if (outcome !== 'rendered') break
          replayCounts.atomics++
          done++
          next++
        }
        emitReplayFrame()
        replayBudget.endFrame()
        if (outcome === 'unbounded' || outcome === 'mismatch') {
          if (outcome === 'unbounded') replayCounts.unbounded++
          else {
            replayCounts.mismatch++
            // H2 fix design rev2 (review point 4): a mismatch leaves the model text off the frozen `R` to `L`
            // mapping, so no input is translated through it: the logical text ends before the abandon.
            endLogical()
          }
          stop(false)
          return
        }
        if (state.pending() === 0) {
          stop(true)
          return
        }
        run.frame = deps.requestAnimationFrame(frame)
      }
      run.frame = deps.requestAnimationFrame(frame)
    })
  }

  /**
   * 036 core C2 (R33.4): ends a replay run once. It cancels the run's scheduled frame, marks it stopped,
   * closes the budget account with the run's own token (a stale token changes nothing), renders the
   * outline the replay's heading writes skipped only when every group rendered (D8.1), and resolves the
   * run's promise once.
   */
  function endRun(run: ReplayRun, ok: boolean): void {
    if (run.stopped) return
    run.stopped = true
    if (run.frame !== undefined) deps.cancelAnimationFrame(run.frame)
    run.frame = undefined
    if (replayRun === run) replayRun = undefined
    replayBudget.finish(run.token)
    if (ok) {
      scheduleOutline()
      replayRendered = run.sequence
      // 036 core C10 (R2.2, T6a): a passive, move-specific completion signal for end-to-end runs: the
      // completed run's own `history-exact` sequence and the time. An abandoned, stopped or superseded run
      // (`ok` false) writes nothing. Numbers only; nothing outside e2e.
      if (deps.e2e)
        (win as unknown as Record<string, unknown>).__vmdeE2EReplayEnd = {
          sequence: run.sequence,
          at: deps.now(),
        }
    }
    run.resolve(ok)
  }

  /**
   * 036 core C3 (L1, R31.2): renders the replay caret's group, when it is still pending, as one charged
   * atomic of its own frame ('none' when there is none to render). An unbounded group or a mismatch ends
   * the replay as in the main loop.
   */
  function renderCaretGroupCharged(
    state: ReplayTarget,
    hasToc: boolean,
  ): 'none' | 'rendered' | 'stopped' {
    const logical = replayLogical
    if (
      !logical ||
      logical.state !== state ||
      logical.caretGroup < 0 ||
      exactAbandoned ||
      !state.isPending(logical.caretGroup)
    )
      return 'none'
    const group = logical.caretGroup
    state.rangeR(group, CARET_RANGE)
    const sizeKb = (CARET_RANGE.to - CARET_RANGE.from) / 1024
    replayCounts.frames++
    replayBudget.beginFrame()
    const outcome = replayBudget.atomic('leaf', sizeKb, () =>
      renderGroup(state, group, hasToc),
    )
    emitReplayFrame()
    replayBudget.endFrame()
    if (outcome === 'rendered') {
      replayCounts.atomics++
      return 'rendered'
    }
    if (outcome === 'unbounded') replayCounts.unbounded++
    else if (outcome === 'mismatch') {
      replayCounts.mismatch++
      endLogical()
    }
    return 'stopped'
  }

  /**
   * 036 core C4 (R34.1): records delivered by the browser during a replay are published as one replay op
   * of that task (paste without `input`, drop, typing). Nothing outside a replay. `deliveryAbsorbMs` keeps
   * the last 256 costs in end-to-end runs only.
   */
  function onReplayDelivered(): void {
    if (!replayLogical) return
    if (!deps.e2e) {
      absorbReplay(postLogicalDelta)
      return
    }
    // R1 off (`__vmdeE2ER1Off`, e2e only): the cost control publishes at the frame as before.
    if (
      (win as unknown as { __vmdeE2ER1Off?: boolean }).__vmdeE2ER1Off === true
    )
      return
    const started = deps.now()
    absorbReplay(postLogicalDelta)
    deliveryAbsorbMs[deliveryAbsorbAt % DELIVERY_SAMPLES] = deps.now() - started
    deliveryAbsorbAt++
  }

  /** 036 core C2 (R2.3): the model holds no dirty unit after a publication: no user edit is outstanding. */
  function noteUserEditsPublished(): void {
    if (model && !model.hasDirty()) userEditEpoch = undefined
  }

  /**
   * 036 core C2 (R3.3, R4.3): the outstanding user edits of their originating epoch go out through the
   * live publisher (delta-sync's `publish` delegates to the logical publisher during a replay), then the
   * pending reapplication (R5.1). Nothing for an edit of an ended epoch: it belongs to the recovery.
   */
  function flushUserEdits(): void {
    if (flushing) return
    flushing = true
    try {
      const current = model
      if (dom && current && live() && servesBuiltMode()) {
        dom.drain()
        if (!current.hasDirty()) userEditEpoch = undefined
        else if (host !== undefined && userEditEpoch === host.epoch)
          replaySync?.publish('flush')
      }
      publishPendingReapply()
    } finally {
      flushing = false
    }
  }

  /**
   * 036 core C2 (R5.1): at a user teardown, each webview-only op of `pendingReapply` is placed only by
   * `provenOffset` in a model built for the whole-rendered DOM: the confirmed model of the epoch, else the
   * build the next frame would run, run once now when the whole render's DOM is complete. A proven op is
   * posted against the host's bytes of that epoch and applied, so the next op is proven against the text
   * that holds it. No layout or no match: counted `lateWriteUnpublished`, never placed elsewhere.
   * Journaled ops stay host entries; `recovery-done` is posted once.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the layout choice, the proof and the per-op post are one disposition
  function publishPendingReapply(): void {
    const pending = pendingReapply
    if (!pending) return
    if (host?.epoch === pending.epoch && !(model && confirmed && live())) {
      if (domComplete && builtMode !== 'sv') {
        const started = deps.now()
        pendingReapply = undefined
        attempt()
        pendingReapply = pending
        recoveryCounts.disposeBuildMs = deps.now() - started
      }
    }
    pendingReapply = undefined
    const current = model
    const layout =
      host?.epoch === pending.epoch &&
      current !== undefined &&
      confirmed &&
      live() &&
      replaySync !== undefined
        ? current
        : undefined
    for (const op of pending.ops) {
      if (op.replayOp !== undefined) continue
      if (!layout || !op.proof || !postProven(layout, op.proof, pending.epoch))
        recoveryCounts.lateWriteUnpublished++
    }
    deps.postReplay?.({ command: 'recovery-done', epoch: pending.refusedEpoch })
  }

  /** 036 core C2 (R5.1): one proven op posted against the host's bytes of `epoch` and applied to the model. */
  function postProven(
    current: TextModel<HTMLElement>,
    proof: RecoveryProof,
    epoch: number,
  ): boolean {
    const from = provenOffset(current, proof)
    if (from < 0 || !replaySync) return false
    const { text } = current
    const to = from + proof.oldText.length
    const start = offsetToPosition(text, from, lineHint(current, from))
    const end = offsetToPosition(text, to, { offset: from, line: start.line })
    if (
      !replaySync.postAgainstHost(
        [{ start, end, oldText: proof.oldText, text: proof.insert }],
        epoch,
      )
    )
      return false
    const applied = applyNow([{ from, to, insert: proof.insert }], true)
    emitReplayFrame()
    if (host) host = { text: current.text, epoch: host.epoch }
    return applied.outcome.kind === 'applied'
  }

  // ---- 036 core C5 (R34.3, R35.3): IME during a replay ----

  /** One composition: its generation, the start range in `R`, and the updates queued until its release. */
  type Composition = {
    gen: number
    range: { rFrom: number; rTo: number } | undefined
    /** `replayCounts.typed` and the model text length at the start: nothing was published since. */
    typedAtStart: number
    lengthAtStart: number
    /** The top-level block of the start caret; a `pointerdown` outside it releases the queue. */
    block: Element | undefined
    queue: Array<() => void>
    firstQueuedAt: number
    timer: number | undefined
    released: boolean
  }
  let composition: Composition | undefined
  let compositionGen = 0
  // Set while the composition's own commit is published: `absorbReplay` reads the DOM then, although the
  // editor's composition lock may still be set (a forced release, or the window listener runs first).
  let compositionCommitting = false
  // The messages a release delivered: the router's handler runs them in full, never queued again.
  const releasedUpdates = new WeakSet<object>()
  /** The bound on a queued update without `compositionend` (R34.3). */
  const COMPOSITION_RELEASE_MS = 5000

  // ---- 036 core C6 (S1, S2): Save during a replay ----

  // R2.4: the replay's own `history-exact` sequence and epoch, from `awaitExactHistory`.
  let replayOwnership: { sequence: number; epoch: number } | undefined
  let saveMark = 0
  const saveWakeListeners = new Set<() => void>()
  let saveWakeQueued = false
  /** Wakes the Save waiters once, after the current task's handlers ran (a release delivers every update first). */
  function wakeSaves(): void {
    if (saveWakeListeners.size === 0 || saveWakeQueued) return
    saveWakeQueued = true
    queueMicrotask(() => {
      saveWakeQueued = false
      for (const listener of [...saveWakeListeners]) listener()
    })
  }
  const noteSaveUnproven = (): void => {
    saveMark++
  }
  const noteResync = (): void => {
    if (replayLogical !== undefined || exactPending !== undefined)
      noteSaveUnproven()
  }

  const rootOf = (target: EventTarget | null): HTMLElement | undefined => {
    const root = deps.getRoot()
    return root && target instanceof Node && root.contains(target)
      ? root
      : undefined
  }

  function startComposition(event: Event): void {
    const root = rootOf(event.target)
    if (!root) return
    const previous = composition
    if (previous && !previous.released) releaseComposition(previous.gen, 'end')
    let block: Element | undefined
    const anchor = root.ownerDocument.getSelection()?.anchorNode
    for (
      let node: Node | null = anchor ?? null;
      node && node !== root;
      node = node.parentNode
    )
      if (node.parentNode === root && node instanceof Element) block = node
    composition = {
      gen: ++compositionGen,
      range: undefined,
      typedAtStart: replayCounts.typed,
      lengthAtStart: model?.text.length ?? -1,
      block,
      queue: [],
      firstQueuedAt: 0,
      timer: undefined,
      released: false,
    }
  }

  /** `compositionend`: intent from `data`, bytes from the DOM (R35.3); a released generation releases nothing. */
  function endComposition(event: Event): void {
    const current = composition
    if (!current || !rootOf(event.target)) return
    if (current.released) {
      composition = undefined
      return
    }
    commitComposition(current, (event as CompositionEvent).data ?? '')
    releaseComposition(current.gen, 'end')
    if (composition === current) composition = undefined
  }

  /**
   * The composition's publication in the epoch it began in (R34.3, R35.3): a cancel (`data === ''`, region
   * unchanged) posts nothing and keeps a pending group; a change posts the DOM's bytes through the replay
   * publisher; a commit over a pending group whose rendered text equals the committed text posts the logical
   * replacement. `data` is `''` for a forced release (the mixed rule against the DOM's current text).
   */
  function commitComposition(current: Composition, data: string): void {
    const logical = replayLogical
    const built = model
    if (!logical || !built || !dom) return
    compositionCommitting = true
    try {
      dom.drain()
      if (built.hasDirty()) {
        absorbReplay(postLogicalDelta)
        return
      }
      logical.intent = undefined
      const range = current.range
      if (
        data === '' ||
        !range ||
        range.rTo <= range.rFrom ||
        replayCounts.typed !== current.typedAtStart ||
        built.text.length !== current.lengthAtStart
      )
        return
      // An identical-rendered commit over a pending group: the DOM did not change, its `L` bytes did.
      const before = built.text
      const changes = translateChanges(
        logical,
        before,
        [
          {
            from: range.rFrom,
            to: range.rTo,
            insert: before.slice(range.rFrom, range.rTo),
          },
        ],
        lineHint(built, range.rFrom),
      )
      if (!changes) {
        failReplayInput()
        return
      }
      if (changes.length === 0) return
      replayCounts.typed++
      postLogicalDelta(changes, undefined)
    } finally {
      compositionCommitting = false
    }
  }

  /**
   * Releases generation `gen` once (R35.3): the commit if not done, then each queued update through the
   * full handler, then the Save wakes. A cause other than `end` is counted `compositionForced`.
   */
  function releaseComposition(
    gen: number,
    cause:
      | 'end'
      | 'blur'
      | 'hidden'
      | 'pagehide'
      | 'mode'
      | 'pointer'
      | 'resume'
      | 'timeout'
      | 'dispose',
  ): void {
    const current = composition
    if (!current || current.gen !== gen || current.released) return
    current.released = true
    if (current.timer !== undefined) deps.clearTimeout(current.timer)
    current.timer = undefined
    if (cause !== 'end') {
      replayCounts.compositionForced++
      commitComposition(current, '')
    }
    const queue = current.queue
    current.queue = []
    for (const deliver of queue) deliver()
    wakeSaves()
  }

  /** On resume (visible, focus): a queue older than the bound is released; no timer runs while suspended. */
  function resumeComposition(): void {
    const current = composition
    if (
      current &&
      !current.released &&
      current.queue.length > 0 &&
      deps.now() - current.firstQueuedAt >= COMPOSITION_RELEASE_MS
    )
      releaseComposition(current.gen, 'resume')
  }

  function deferUpdateForComposition<M extends object>(
    msg: M,
    deliver: (msg: M) => void,
  ): boolean {
    if (releasedUpdates.has(msg)) return false
    const current = composition
    if (!current || current.released) return false
    if (
      replayLogical === undefined &&
      recovery === undefined &&
      exactPending === undefined
    )
      return false
    current.queue.push(() => {
      releasedUpdates.add(msg)
      deliver(msg)
    })
    if (current.queue.length === 1) {
      current.firstQueuedAt = deps.now()
      current.timer = deps.setTimeout(
        () => releaseComposition(current.gen, 'timeout'),
        COMPOSITION_RELEASE_MS,
      )
    }
    return true
  }

  /** The release causes of R35.3, on the window and its document; removed at dispose. */
  function installCompositionListeners(): () => void {
    const doc = win.document
    const onStart = (event: Event): void => startComposition(event)
    const onEnd = (event: Event): void => endComposition(event)
    const onBlur = (event: Event): void => {
      const current = composition
      if (current && event.target === deps.getRoot())
        releaseComposition(current.gen, 'blur')
    }
    const onPointer = (event: Event): void => {
      const current = composition
      if (!current || current.released) return
      const target = event.target
      if (!(target instanceof Node) || !current.block?.contains(target))
        releaseComposition(current.gen, 'pointer')
    }
    const onVisibility = (): void => {
      const current = composition
      if (doc.visibilityState === 'hidden') {
        if (current) releaseComposition(current.gen, 'hidden')
      } else resumeComposition()
    }
    const onPageHide = (): void => {
      const current = composition
      if (current) releaseComposition(current.gen, 'pagehide')
    }
    const onFocus = (): void => resumeComposition()
    // Capture for the start (before the history guard renders the endpoints); bubble for the end, so the
    // editor's own `compositionend` handler has written its final DOM first.
    win.addEventListener('compositionstart', onStart, true)
    win.addEventListener('compositionend', onEnd)
    win.addEventListener('blur', onBlur, true)
    win.addEventListener('pointerdown', onPointer, true)
    win.addEventListener('pagehide', onPageHide)
    win.addEventListener('focus', onFocus, true)
    doc.addEventListener('visibilitychange', onVisibility)
    return () => {
      win.removeEventListener('compositionstart', onStart, true)
      win.removeEventListener('compositionend', onEnd)
      win.removeEventListener('blur', onBlur, true)
      win.removeEventListener('pointerdown', onPointer, true)
      win.removeEventListener('pagehide', onPageHide)
      win.removeEventListener('focus', onFocus, true)
      doc.removeEventListener('visibilitychange', onVisibility)
    }
  }
  const removeCompositionListeners =
    typeof win.addEventListener === 'function'
      ? installCompositionListeners()
      : undefined

  /** A replay is awaited, live, abandoned or recovering. O(1). */
  const replayActive = (): boolean =>
    replayLogical !== undefined ||
    exactPending !== undefined ||
    exactAbandoned ||
    abandonedReplay !== undefined ||
    recovery !== undefined

  /** S2 (R33.3): a recovery, a host write, an abandon, or a rebind other than the replay's own. */
  const heldForSave = (): boolean =>
    recovery !== undefined ||
    awaitingWrite ||
    exactAbandoned ||
    abandonedReplay !== undefined ||
    (awaited !== undefined && !ownsHostForSave())

  /** S2 (R33.3): a reply waits; false outside a replay, a recovery and a composition queue. */
  function saveBlocked(): boolean {
    const current = composition
    const queued = current !== undefined && !current.released
    if (!replayActive() && !(queued && current.queue.length > 0)) return false
    if (queued || heldForSave()) return true
    const built = model
    if (!built || !dom || !live()) return false
    dom.drain()
    return built.hasDirty() || modelInternals(built).structure.size > 0
  }

  function ownsHostForSave(): boolean {
    const token = replayOwnership
    return (
      token !== undefined &&
      (exactPending === undefined || exactPending === token.sequence) &&
      (awaited === undefined || awaited === token.sequence) &&
      host?.epoch === token.epoch &&
      !exactAbandoned &&
      abandonedReplay === undefined &&
      recovery === undefined &&
      !awaitingWrite &&
      replayLogical !== undefined &&
      replaySync !== undefined &&
      live() &&
      servesBuiltMode()
    )
  }

  // ---- Task 733 / 036 (step C, fix design 2.3, 2.6, 2.7): input and history moves during a replay ----

  /** Hands the logical publisher to delta-sync for a replay state; the counts carry across a supersession. */
  function beginLogical(
    state: ReplayTarget,
    caretGroup: number,
    isRedo: boolean,
  ): void {
    if (!model) return
    replayLogical = {
      state,
      lines: lineDeltas(state, model.text),
      intent: undefined,
      caretGroup,
      hasToc: model.units.some((unit) => unit.kind === 'toc'),
      isRedo,
    }
    replaySync?.setLogicalPublisher(logicalPublisher)
  }

  /** Ends the logical text: publications go through the model's own deltas again. */
  function endLogical(): void {
    replayOwnership = undefined
    if (!replayLogical) return
    replayLogical = undefined
    replaySync?.setLogicalPublisher(undefined)
    wakeSaves()
  }

  /** The replay is over once the move is answered, every group rendered and every operation acknowledged (2.5). */
  function maybeEndLogical(): void {
    const logical = replayLogical
    // D6.1: an abandoned replay keeps its logical text until the resync's host text.
    if (
      !logical ||
      exactPending !== undefined ||
      exactAbandoned ||
      logical.state.pending() > 0
    )
      return
    if ((replaySync?.replayLedger().length ?? 0) > 0) return
    endLogical()
    recoveryJournal = []
    if (host && model?.state === 'live' && !model.hasDirty())
      host = { text: model.text, epoch: host.epoch }
  }

  /** The logical text cannot be reached for an input: the replay is given up and the host resynchronizes (3.5). */
  function failReplayInput(): void {
    replayCounts.inputFailed++
    noteSaveUnproven()
    // D6.1: already abandoned; the abandon was posted. Without the logical text publication is held.
    if (exactAbandoned) {
      endLogical()
      return
    }
    const sequence = exactPending
    const oldest = replaySync?.oldestReplay()
    endLogical()
    if (sequence !== undefined) abandonExact(sequence)
    else if (oldest) deps.postReplay?.({ command: 'replay-abandon', ...oldest })
  }

  /** The `L` position of the `R` offset `p` (outside pending groups); `rPos` is its position in `R`. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the line sums the groups before `p`; the column walks back over groups and gaps to the line start
  function logicalPosition(
    logical: NonNullable<typeof replayLogical>,
    rendered: string,
    p: number,
    rPos: LinePosition,
  ): LinePosition {
    const { state, lines } = logical
    const r = { from: 0, to: 0 }
    const t = { from: 0, to: 0 }
    let line = rPos.line
    let last = -1
    for (let g = 0; g < state.count; g++) {
      if (!state.isPending(g)) continue
      state.rangeR(g, r)
      if (r.to > p) break
      line += lines[g]
      last = g
    }
    if (last < 0) return { line, character: rPos.character }
    state.rangeR(last, r)
    // The line starts in the gap after the last group before `p`: the `R` column is the `L` column.
    if (p - rPos.character > r.to) return { line, character: rPos.character }
    let character = p - r.to
    for (let g = last; ; ) {
      state.rangeT(g, t)
      const nl = t.to > t.from ? state.target.lastIndexOf('\n', t.to - 1) : -1
      if (nl >= t.from) return { line, character: character + t.to - nl - 1 }
      character += t.to - t.from
      state.rangeR(g, r)
      const gapEnd = r.from
      let previous = g - 1
      while (previous >= 0 && !state.isPending(previous)) previous--
      let gapStart = 0
      if (previous >= 0) {
        state.rangeR(previous, r)
        gapStart = r.to
      }
      const gapNl = gapEnd > 0 ? rendered.lastIndexOf('\n', gapEnd - 1) : -1
      if (gapNl >= gapStart)
        return { line, character: character + gapEnd - gapNl - 1 }
      character += gapEnd - gapStart
      if (previous < 0) return { line, character }
      g = previous
    }
  }

  /**
   * The model's changes of one sync, in `R` against `before`, as host changes in `L` (2.3): every position
   * and `oldText` is read against the logical text before this operation; the state then applies the
   * changes from the last, so each one's `R` offsets stay valid. Undefined when an endpoint lies inside a
   * pending group (the caller renders endpoints first, so that is a failure).
   */
  function translateChanges(
    logical: NonNullable<typeof replayLogical>,
    before: string,
    raw: readonly TextChange[],
    hint: { offset: number; line: number } | undefined,
  ): ReplayChanges | undefined {
    const { state } = logical
    const out: ReplayChanges = []
    let previous = hint
    for (const change of raw) {
      if (
        typeof state.rToL(change.from) === 'string' ||
        typeof state.rToL(change.to) === 'string'
      )
        return undefined
      const rStart = offsetToPosition(before, change.from, previous)
      const rEnd = offsetToPosition(before, change.to, {
        offset: change.from,
        line: rStart.line,
      })
      previous = { offset: change.to, line: rEnd.line }
      out.push({
        start: logicalPosition(logical, before, change.from, rStart),
        end: logicalPosition(logical, before, change.to, rEnd),
        oldText: '',
        text: change.insert,
      })
    }
    for (let i = raw.length - 1; i >= 0; i--) {
      const change = raw[i]
      const applied = state.applyChange(before, {
        rFrom: change.from,
        rTo: change.to,
        insert: change.insert,
      })
      if (typeof applied === 'string') return undefined
      out[i].oldText = applied.oldText
    }
    return out.filter((change) => change.oldText !== change.text)
  }

  /**
   * Publishes what the DOM changed since the last sync as one replay operation through `post` (2.5: absorb
   * user input). With a captured intent the change keeps the whole intent range (2.3). Nothing is
   * published while composing. 'failed' ends the replay.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the gates, the sync, the intent widening and the translation are one publication
  function absorbReplay(
    post: (changes: ReplayChanges, proof: RecoveryProof | undefined) => void,
  ): 'delta' | 'nothing' | 'failed' {
    const logical = replayLogical
    const current = model
    if (!logical || !current || !dom || !replaySync) return 'nothing'
    if (!live() || !servesBuiltMode()) {
      failReplayInput()
      return 'failed'
    }
    dom.drain()
    if (deps.isComposing() && !compositionCommitting) return 'nothing'
    const mutated = current.hasDirty()
    if (!mutated) {
      logical.intent = undefined
      return 'nothing'
    }
    const before = current.text
    const result = current.sync(replaySync.lastPostedSequence() + 1)
    changedAtSet = true
    noteUserEditsPublished()
    if (result.kind === 'fallback') {
      failReplayInput()
      return 'failed'
    }
    const intent = logical.intent
    logical.intent = undefined
    let raw: readonly TextChange[] = result.changes
    if (intent) {
      const joined = committedInput(
        intent,
        before.length,
        current.text,
        raw.length > 0
          ? {
              rFrom: raw[0].from,
              rTo: raw[raw.length - 1].to,
              insert: '',
            }
          : null,
        true,
      )
      if (joined)
        raw = [{ from: joined.rFrom, to: joined.rTo, insert: joined.insert }]
    }
    if (raw.length === 0) return 'nothing'
    const changes = translateChanges(
      logical,
      before,
      raw,
      lineHint(current, raw[0].from),
    )
    if (!changes) {
      failReplayInput()
      return 'failed'
    }
    restartSoon()
    emitSync()
    replayCounts.typed++
    post(changes, recoveryProofOf(current, before, raw, changes))
    return 'delta'
  }

  /**
   * Task 733 / 036 (E2, fix design 3.6): the unit proof of one translated replay delta, read after the sync
   * (the unit's start is before the change, so it is the same in `before`). Its source in `before` is a
   * slice, not a copy. Undefined when the change is not inside one unit or the unit holds a pending group
   * (its rendered bytes are then not its `L` bytes).
   */
  function recoveryProofOf(
    built: TextModel<HTMLElement>,
    before: string,
    raw: readonly TextChange[],
    changes: ReplayChanges,
  ): RecoveryProof | undefined {
    if (raw.length !== 1 || changes.length !== 1) return undefined
    const change = raw[0]
    const index = topUnitIndexAt(built.units, change.from)
    if (index < 0) return undefined
    const unit = built.units[index]
    const delta = change.insert.length - (change.to - change.from)
    const oldEnd = unit.end - delta
    if (
      change.from + change.insert.length > unit.end ||
      oldEnd < change.to ||
      pendingIn(unit.start, unit.end)
    )
      return undefined
    return {
      unitText: before.slice(unit.start, oldEnd),
      unitIndex: index,
      inUnit: change.from - unit.start,
      oldText: changes[0].oldText,
      insert: change.insert,
    }
  }

  /** Task 733 / 036 (E2): posts one replay delta and keeps it, with its proof, until it is acknowledged. */
  const postJournaled = (
    changes: ReplayChanges,
    perf: Parameters<ReplaySync['postReplayDelta']>[1],
    proof: RecoveryProof | undefined,
  ): void => {
    if (changes.length === 0) return
    const posted = replaySync?.postReplayDelta(changes, perf)
    if (posted && host)
      recoveryJournal.push({
        epoch: host.epoch,
        replayOp: posted.replayOp,
        proof,
      })
  }

  const postLogicalDelta = (
    changes: ReplayChanges,
    proof: RecoveryProof | undefined,
  ): void => postJournaled(changes, undefined, proof)

  // Delta-sync's `publish` delegates here while a replay is active (B0, 3.5).
  const logicalPublisher: LogicalPublisher = {
    publish(_cause, perf) {
      const outcome = absorbReplay((changes, proof) =>
        postJournaled(changes, perf, proof),
      )
      maybeEndLogical()
      // R33.3: a failed absorb is `'fallback'`, never counted as published.
      if (outcome === 'failed') return 'fallback'
      return outcome
    },
  }

  // ---- Task 733 / 036 (E, E2, fix design 3.5-3.6): a host text ends the replay; recovery ----

  /** Drops the journal entries the host acknowledged (`replayOp` and below of `epoch`). */
  function pruneRecoveryJournal(epoch: number, replayOp: number): void {
    if (recoveryJournal.length === 0) return
    const first = recoveryJournal[0]
    if (
      first.epoch === epoch &&
      first.replayOp !== undefined &&
      first.replayOp > replayOp
    )
      return
    recoveryJournal = recoveryJournal.filter(
      (entry) =>
        entry.epoch === epoch &&
        entry.replayOp !== undefined &&
        entry.replayOp > replayOp,
    )
  }

  /** Stops a recovery that is still rendering (a host text replaced it, or teardown). */
  function cancelRecovery(): void {
    const run = recovery
    if (!run) return
    recovery = undefined
    wakeSaves()
    run.cancelled = true
    if (run.frame !== undefined) deps.cancelAnimationFrame(run.frame)
    run.frame = undefined
    replayBudget.finish(run.token)
  }

  /** Ends the replay at once (generation bump): the engine and every awaited move stop at their next check. */
  function endReplayForHostText(): void {
    endExactWait()
    endLogical()
    if (replayRun) endRun(replayRun, false)
    replayRendered = undefined
    awaited = undefined
    prediction = undefined
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the gates, the refused operations, the replay end and the render start are one hand-off
  function recoverReplay(
    text: string,
    epoch: number | undefined,
    replayAfterOp: number | undefined,
    whole: (text: string) => void,
  ): ReplayRecovery {
    // H2 fix design rev2 (D6.2): an abandoned replay awaiting its resync is active too.
    const active =
      replayLogical !== undefined ||
      exactReplay !== undefined ||
      abandonedReplay !== undefined ||
      replayRun !== undefined ||
      recovery !== undefined
    if (!active) return 'none'
    const previous = recovery
    if (
      !previous &&
      epoch !== undefined &&
      host !== undefined &&
      epoch <= host.epoch
    )
      return 'none'
    const refusedEpoch =
      previous?.refusedEpoch ?? host?.epoch ?? exactReplay?.epoch ?? 0
    const newEpoch = epoch ?? host?.epoch ?? 0
    const ops = previous?.ops ?? []
    // 036 core C6 (S2): a Save waiting across this resync is never counted clean.
    noteSaveUnproven()
    cancelRecovery()
    if (!previous) {
      recoveryCounts.started++
      const after = replayAfterOp ?? 0
      for (const entry of recoveryJournal)
        if (
          entry.epoch === refusedEpoch &&
          entry.replayOp !== undefined &&
          entry.replayOp > after
        )
          ops.push(entry)
      recoveryJournal = []
      // Typing not posted yet was typed in the ended epoch: it is kept for reapplication, not posted.
      if (replayLogical)
        absorbReplay((_changes, proof) =>
          ops.push({ epoch: refusedEpoch, replayOp: undefined, proof }),
        )
    }
    endReplayForHostText()
    const target = normalizeEol(text)
    host = { text: target, epoch: newEpoch }
    stale = true
    confirmed = false
    const current = model
    if (
      !current ||
      !dom ||
      !live() ||
      builtMode === 'sv' ||
      current.hasDirty()
    ) {
      recoveryCounts.whole++
      finishRecoveryOps(refusedEpoch, [])
      return 'fallback'
    }
    const { prefix, suffix } = commonEnds(current.text, target)
    const done = alignedRecoveryStart(current.units, prefix)
    recovery = {
      target,
      epoch: newEpoch,
      refusedEpoch,
      done,
      realignedAt: -1,
      tail: Math.min(
        alignedRecoveryTail(current.units, current.text.length, suffix),
        current.text.length - done,
        target.length - done,
      ),
      ops,
      whole,
      frame: undefined,
      token: replayBudget.open(),
      cancelled: false,
      yieldedLast: false,
    }
    const run = recovery
    run.frame = deps.requestAnimationFrame(() => recoveryFrameFor(run))
    return 'recovering'
  }

  /** One frame of the recovery render: chunks of the host text, each one atomic under the replay budget. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the correlation gate, the budgeted chunks and the stop rules
  function recoveryFrameFor(run: NonNullable<typeof recovery>): void {
    // 036 core C2 (R32.2): the callback is bound to its run; an old run's callback touches nothing.
    if (recovery !== run || run.cancelled) return
    run.frame = undefined
    const current = model
    if (!current || !dom || !live() || builtMode === 'sv') {
      failRecovery(run)
      return
    }
    if (deps.isComposing()) {
      run.frame = deps.requestAnimationFrame(() => recoveryFrameFor(run))
      return
    }
    dom.drain()
    // 036 core C5 (M2, R2.2): a late write (an IME's final write after a forced release) is published
    // before any render can replace it; path 3 ends the recovery.
    if (current.hasDirty() && !absorbRecoveryWrite(run, current)) return
    // 036 core C3 (L1): the recovery yields to an input as the replay does (no caret group here).
    if (inputSeen && !run.yieldedLast) {
      inputSeen = false
      run.yieldedLast = true
      recoveryCounts.yielded++
      run.frame = deps.requestAnimationFrame(() => recoveryFrameFor(run))
      return
    }
    run.yieldedLast = false
    replayBudget.beginFrame()
    const underInput = deps.now() - inputAt < INPUT_PACK_MS
    let atomics = 0
    let step: ReturnType<typeof recoveryStep> = 'moved'
    for (;;) {
      if (atomics > 0 && underInput) break
      // S4 repair (fix 6): the frame's first atomic runs alone when it does not fit, counted.
      if (!replayBudget.admit('leaf', RECOVERY_CHUNK / 1024)) {
        if (atomics > 0) break
        recoveryCounts.forced++
      }
      const oversize = recoveryCounts.oversize
      step = replayBudget.atomic('leaf', RECOVERY_CHUNK / 1024, () =>
        recoveryStep(current, run),
      )
      if (step !== 'moved') break
      atomics++
      // S4 repair (fix 5): a unit over the chunk size renders alone: it ends the frame.
      if (recoveryCounts.oversize !== oversize) break
    }
    emitReplayFrame()
    replayBudget.endFrame()
    if (recovery !== run) return
    if (step === 'failed') {
      failRecovery(run)
      return
    }
    if (step !== 'done') {
      run.frame = deps.requestAnimationFrame(() => recoveryFrameFor(run))
      return
    }
    recovery = undefined
    stale = false
    confirmed = true
    schedule?.restart()
    finishRecoveryOps(run.refusedEpoch, run.ops)
    host = { text: current.text, epoch: run.epoch }
    scheduleOutline()
    replayBudget.finish(run.token)
  }

  /**
   * H2 fix design rev2 (S3 review point 3): one recovery atomic from the aligned offset `run.done`. Equal
   * unit spans of the rendered and the host text are skipped; then one changed unit of each text (a
   * compatible pair: list item for list item, block for block) is applied alone, its selection kept. A
   * chunk the plan or its render preflight refuses grows by one segment per side, each end on a boundary
   * of its own text and never inside a list run, up to `RECOVERY_GROW`; a refusal after the write began,
   * or a host block that does not end within the scan cap, is `failed` (the whole render, counted).
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the boundary scan, the equal skip and the growing chunk are one aligned step
  function recoveryStep(
    current: TextModel<HTMLElement>,
    run: NonNullable<typeof recovery>,
  ): 'moved' | 'done' | 'failed' {
    const text = current.text
    const { target, tail } = run
    const units = current.units
    const rEnd = text.length - tail
    const hEnd = target.length - tail
    let done = run.done
    if (done >= rEnd && done >= hEnd) return 'done'
    // The host blocks from `done`: every start but the last block's is a real boundary unless the scan
    // reached the end of the host text (a cut last line can read as another block).
    let blocks: MovableBlock[] = []
    let whole = false
    for (
      let span = RECOVERY_SCAN;
      ;
      span = Math.min(2 * span, RECOVERY_SCAN_LIMIT)
    ) {
      // S4 repair (fix 3): the span is clamped to the cap before the slice is read.
      const to = Math.min(target.length, done + span)
      whole = to === target.length
      blocks = (builtScan ?? scanMovableBlocks)(target.slice(done, to))
      if (whole || blocks.length >= 3 || span >= RECOVERY_SCAN_LIMIT) break
    }
    // The end of host segment `j` (the next block's start), or -1 when not a proven boundary.
    const hEndOf = (j: number): number => {
      if (j + 1 < blocks.length && (whole || j + 2 < blocks.length))
        return done + blocks[j + 1].start
      return whole && j === blocks.length - 1 ? target.length : -1
    }
    const rEndOf = (i: number): number =>
      i + 1 < units.length ? units[i + 1].start : text.length
    let i = done === 0 ? 0 : unitAtOrBefore(units, done)
    // The aligned offset starts a rendered unit. S4 repair (fix 4): a write whose window grew past its
    // chunk (a host fence that swallowed following units) leaves `done` inside a rendered unit; the bytes
    // before `done` are the host's, so the step goes back once to that unit's start.
    if (done < rEnd && done !== 0 && units[i]?.start !== done) {
      const start = i >= 0 ? units[i].start : 0
      if (run.realignedAt === start) return 'failed'
      run.realignedAt = start
      run.done = start
      recoveryCounts.realigned++
      return 'moved'
    }
    let j = 0
    // Equal spans: the same kind and the same bytes over the same length.
    while (i < units.length && j < blocks.length) {
      const rTo = rEndOf(i)
      const hTo = hEndOf(j)
      if (hTo < 0 || rTo > rEnd || hTo > hEnd) break
      if (
        rTo !== hTo ||
        units[i].kind !== blocks[j].kind ||
        !equalSpan(text, target, done, rTo - done)
      )
        break
      done = rTo
      i++
      j++
    }
    if (done !== run.done) {
      run.done = done
      return done >= rEnd && done >= hEnd ? 'done' : 'moved'
    }
    if (blocks.length === 0 && done < hEnd) return 'failed'
    // A changed pair, growing by one segment per side while the chunk is refused at plan time.
    let rCount = done < rEnd ? 1 : 0
    let hCount = done < hEnd ? 1 : 0
    // A list item against a block of another kind: a list run ends or starts here in one text only. The
    // item side goes first alone (a deletion or an insertion), so no chunk mixes items with blocks.
    const rItem = rCount > 0 && units[i]?.kind === 'list-item'
    const hItem = hCount > 0 && blocks[0]?.kind === 'list-item'
    if (rCount > 0 && hCount > 0 && rItem !== hItem) {
      if (rItem) hCount = 0
      else rCount = 0
    }
    // One chunk of `rc` rendered and `hc` host segments; 'refused' when its plan refuses (nothing written).
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: both ends on boundaries of both texts, then one checked write
    function attempt(
      rc: number,
      hc: number,
      extend: boolean,
    ): 'refused' | 'moved' | 'done' | 'failed' {
      let rTo = done
      let ri = i
      for (let n = 0; n < rc && rTo < rEnd; n++) rTo = rEndOf(ri++)
      // A grown chunk never ends inside a list run of either text (a list item of one pair is compatible).
      while (extend && rTo < rEnd && inListRun(units, ri)) rTo = rEndOf(ri++)
      let hTo = done
      let hj = 0
      for (let n = 0; n < hc && hTo >= 0 && hTo < hEnd; n++) hTo = hEndOf(hj++)
      while (extend && hTo >= 0 && hTo < hEnd && inBlockRun(blocks, hj))
        hTo = hEndOf(hj++)
      // S4 repair (fix 4): a host block that crosses the aligned tail (a fence the host opened over the
      // shared suffix) proves the tail is no host boundary: the tail is dropped and the step reads again.
      if (hTo > hEnd && tail > 0) {
        run.tail = 0
        recoveryCounts.tailDropped++
        return 'moved'
      }
      if (hTo < 0 || rTo > rEnd || hTo > hEnd) return 'failed'
      rCount = ri - i
      hCount = hj
      // The change is the chunk less its common ends, so a kept endpoint outside it maps exactly.
      const head = commonHead(text, target, done, Math.min(rTo, hTo) - done)
      const back = commonBack(
        text,
        target,
        rTo,
        hTo,
        Math.min(rTo, hTo) - done - head,
      )
      const from = done + head
      const to = rTo - back
      const insert = target.slice(from, hTo - back)
      keptSelection = undefined
      const prepared = prepareApply([{ from, to, insert }])
      if (!('commit' in prepared)) return 'refused'
      if (Math.max(rTo, hTo) - done > RECOVERY_CHUNK) recoveryCounts.oversize++
      const applied = commitPrepared(prepared, true, true)
      if (applied.outcome.kind !== 'applied') {
        keptSelection = undefined
        return 'failed'
      }
      restoreKeptSelection(from, to - from, insert.length, false)
      // The write is checked against the host bytes (2.3); a difference is not retried.
      if (!equalSpan(current.text, target, done, hTo - done)) return 'failed'
      run.done = hTo
      recoveryCounts.atomics++
      return hTo >= hEnd && current.text.length - tail <= hTo ? 'done' : 'moved'
    }
    let result = attempt(rCount, hCount, false)
    // Two list items that do not pair (a list number, another marker): the rendered item leaves first,
    // else the host item comes first.
    if (
      result === 'refused' &&
      rCount === 1 &&
      hCount === 1 &&
      rItem &&
      hItem
    ) {
      result = attempt(1, 0, false)
      if (result === 'refused') result = attempt(0, 1, false)
      rCount = 1
      hCount = 1
    }
    for (let grow = 1; result === 'refused' && grow < RECOVERY_GROW; grow++) {
      const rTo = done < rEnd ? rCount : 0
      const hTo = done < hEnd ? hCount : 0
      recoveryCounts.grown++
      result = attempt(
        rTo + (done < rEnd ? 1 : 0),
        hTo + (done < hEnd ? 1 : 0),
        true,
      )
    }
    return result === 'refused' ? 'failed' : result
  }

  /**
   * The host text cannot render by units: the caller renders `run.target` whole (036 core C5, R3.1: the
   * updated target, so a path-1 edit already posted stays). R3.2: `run.ops` are kept for the rebuilt
   * model; `recovery-done` waits for their disposition (`pendingReapply`).
   */
  function failRecovery(run: NonNullable<typeof recovery>): void {
    cancelRecovery()
    noteSaveUnproven()
    recoveryCounts.whole++
    if (pendingReapply) settlePendingReapply()
    pendingReapply = {
      refusedEpoch: run.refusedEpoch,
      epoch: run.epoch,
      target: run.target,
      ops: run.ops,
    }
    run.whole(run.target)
    scheduleOutline()
  }

  /**
   * 036 core C5 (M2, R2.2): one late user write during a recovery, by exactly one of three paths, never
   * through the ordinary publisher. (1) Every change lies where the rendered text already equals the host
   * text (the prefix `[0, run.done)` or the common suffix): posted against the host bytes and spliced into
   * `run.target`. (2) A proven unit with a change in the region not rendered yet: kept with its proof in
   * `run.ops` for reapplication. (3) Otherwise: the recovery ends whole, counted `lateWriteUnpublished`.
   * True when the recovery goes on.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the sync, the region test and the three paths are one disposition
  function absorbRecoveryWrite(
    run: NonNullable<typeof recovery>,
    current: TextModel<HTMLElement>,
  ): boolean {
    const before = current.text
    const result = replaySync
      ? current.sync(replaySync.lastPostedSequence() + 1)
      : undefined
    if (!result || result.kind === 'fallback' || result.changes.length === 0) {
      if (result && result.kind !== 'fallback') return true
      return lateWriteFails(run)
    }
    const raw = result.changes
    const suffixFrom = before.length - run.tail
    const shift = run.target.length - before.length
    let inHostBytes = true
    for (const change of raw)
      if (!(change.to <= run.done || change.from >= suffixFrom))
        inHostBytes = false
    if (inHostBytes && postInHostBytes(run, raw, before, shift)) return true
    if (!inHostBytes) {
      const oldText =
        raw.length === 1 ? before.slice(raw[0].from, raw[0].to) : ''
      const proof =
        raw.length === 1
          ? recoveryProofOf(current, before, raw, [
              {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
                oldText,
                text: raw[0].insert,
              },
            ])
          : undefined
      if (proof) {
        run.ops.push({ epoch: run.refusedEpoch, replayOp: undefined, proof })
        return true
      }
    }
    return lateWriteFails(run)
  }

  /** 036 core C5 (M2 path 1): the changes, mapped into `run.target`, posted against the host bytes. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the mapping, the post and the target splice with its prefix and tail shifts
  function postInHostBytes(
    run: NonNullable<typeof recovery>,
    raw: readonly TextChange[],
    before: string,
    shift: number,
  ): boolean {
    const target = run.target
    const changes: ReplayChanges = []
    const mapped: TextChange[] = []
    for (const change of raw) {
      const delta = change.from >= run.done ? shift : 0
      const from = change.from + delta
      const to = change.to + delta
      const oldText = target.slice(from, to)
      if (oldText !== before.slice(change.from, change.to)) return false
      const start = offsetToPosition(target, from)
      const end = offsetToPosition(target, to, {
        offset: from,
        line: start.line,
      })
      changes.push({ start, end, oldText, text: change.insert })
      mapped.push({ from, to, insert: change.insert })
    }
    if (!replaySync?.postAgainstHost(changes, run.epoch)) return false
    let next = target
    for (let i = mapped.length - 1; i >= 0; i--) {
      const m = mapped[i]
      next = next.slice(0, m.from) + m.insert + next.slice(m.to)
      const grow = m.insert.length - (m.to - m.from)
      if (m.from < run.done) run.done += grow
      else run.tail += grow
    }
    run.target = next
    host = { text: next, epoch: run.epoch }
    return true
  }

  /** 036 core C5 (M2 path 3): the write cannot be placed: the recovery ends whole (Q-267), counted. */
  function lateWriteFails(run: NonNullable<typeof recovery>): false {
    recoveryCounts.lateWriteUnpublished++
    failRecovery(run)
    return false
  }

  /**
   * 036 core C5 (R3.2): the rebuilt model of the pending epoch is confirmed: every kept op is reapplied
   * against it once (`reapply`'s proof), then `recovery-done`.
   */
  function finishPendingReapply(): void {
    const pending = pendingReapply
    if (!pending || host?.epoch !== pending.epoch) return
    pendingReapply = undefined
    finishRecoveryOps(pending.refusedEpoch, pending.ops)
  }

  /**
   * 036 core C5 (R3.2): no build confirmed the pending epoch before a newer host text or a failure:
   * every webview-only op is counted `lateWriteUnpublished` (Q-267), journaled ops stay host entries,
   * `recovery-done` is posted once. Nothing waits forever.
   */
  function settlePendingReapply(): void {
    const pending = pendingReapply
    if (!pending) return
    pendingReapply = undefined
    for (const op of pending.ops)
      if (op.replayOp === undefined) recoveryCounts.lateWriteUnpublished++
    deps.postReplay?.({ command: 'recovery-done', epoch: pending.refusedEpoch })
  }

  /**
   * Reapplies every refused edit with a proven base and position (fix design 3.6), in order, each as an
   * operation of the new epoch naming the operation it reapplies; the others stay host entries. Then
   * `recovery-done` names the ended epoch.
   */
  function finishRecoveryOps(
    refusedEpoch: number,
    ops: readonly RecoveryOp[],
  ): void {
    for (const op of ops)
      if (reapply(op, refusedEpoch)) recoveryCounts.reapplied++
      // 036 core C5 (R3.2, Q-267): a webview-only write the proof cannot place is counted, never kept.
      else if (op.replayOp === undefined) recoveryCounts.lateWriteUnpublished++
      else recoveryCounts.kept++
    deps.postReplay?.({ command: 'recovery-done', epoch: refusedEpoch })
    wakeSaves()
  }

  /**
   * One refused edit, reapplied only when its unit, as it was in `L` before the edit, occurs in the model
   * exactly once and at the same index, and its old bytes sit at the mapped offset. An insertion's empty
   * old text proves nothing, so it needs the same unit proof.
   */
  function reapply(op: RecoveryOp, refusedEpoch: number): boolean {
    const proof = op.proof
    const current = model
    if (!proof || !current || !replaySync) return false
    const from = provenOffset(current, proof)
    if (from < 0) return false
    const { text } = current
    const to = from + proof.oldText.length
    const start = offsetToPosition(text, from, lineHint(current, from))
    const end = offsetToPosition(text, to, { offset: from, line: start.line })
    const applied = applyNow([{ from, to, insert: proof.insert }], true)
    emitReplayFrame()
    if (applied.outcome.kind !== 'applied') return false
    const posted = replaySync.postReplayDelta(
      [{ start, end, oldText: proof.oldText, text: proof.insert }],
      undefined,
      op.replayOp === undefined
        ? undefined
        : { epoch: refusedEpoch, replayOp: op.replayOp },
    )
    return posted !== undefined
  }

  /** The first group whose `R` range ends at or after `from` (ranges are monotonic over all groups). */
  const firstGroupFrom = (state: ReplayTarget, from: number): number => {
    const r = { from: 0, to: 0 }
    let low = 0
    let high = state.count
    while (low < high) {
      const mid = (low + high) >> 1
      state.rangeR(mid, r)
      if (r.to < from) low = mid + 1
      else high = mid
    }
    return low
  }

  /** A pending group touches `[from, to]` of `R`. */
  const pendingIn = (from: number, to: number): boolean => {
    const logical = replayLogical
    if (!logical) return false
    const { state } = logical
    const r = { from: 0, to: 0 }
    for (let g = firstGroupFrom(state, from); g < state.count; g++) {
      state.rangeR(g, r)
      if (r.from > to) return false
      if (state.isPending(g)) return true
    }
    return false
  }

  /** One rendered group: its old `R` range start and its old and new lengths. */
  type GroupMove = { from: number; oldLength: number; newLength: number }

  /** Renders every pending group touching `[from, to]` of `R`; false when one cannot render. */
  function renderTouching(
    from: number,
    to: number,
    moves: GroupMove[],
  ): boolean {
    const logical = replayLogical
    if (!logical) return true
    // H2 fix design rev2 (D6.1): an abandoned replay renders nothing; a pending group there has no proof.
    if (exactAbandoned) return !pendingIn(from, to)
    const { state } = logical
    const r = { from: 0, to: 0 }
    const t = { from: 0, to: 0 }
    let end = to
    for (let g = firstGroupFrom(state, from); g < state.count; g++) {
      state.rangeR(g, r)
      if (r.from > end) break
      if (!state.isPending(g)) continue
      state.rangeT(g, t)
      const move = {
        from: r.from,
        oldLength: r.to - r.from,
        newLength: t.to - t.from,
      }
      // S4 repair (fix 7): an input's endpoint render is an atomic of the replay account (charged to the
      // task it runs in; over the budget it is a miss).
      const outcome = replayBudget.atomic(
        'endpoint-render',
        move.oldLength / 1024,
        () => renderGroup(state, g, logical.hasToc),
      )
      if (outcome !== 'rendered') return false
      replayCounts.atomics++
      moves.push(move)
      end += move.newLength - move.oldLength
    }
    return true
  }

  /** A selection endpoint: its leaf unit's `R` range, the rendered offset in the unit's element, its texts. */
  type SavedPoint = {
    start: number
    end: number
    rel: number
    positional: boolean
    /** The point sat inside a Markdown marker: a tie keeps the marker side (caret affinity). */
    inMarker: boolean
    /**
     * A rendered group that began before the unit and reached into it: its new `R` range (Undo lands at
     * its start, Redo at its end); -1 when none did.
     */
    overlapFrom: number
    overlapTo: number
    oldText: string
    hunks: {
      oldStarts: number[]
      oldEnds: number[]
      newStarts: number[]
      newEnds: number[]
    }
  }

  const savePoint = (node: Node, offset: number): SavedPoint | undefined => {
    const current = model
    const unit = nearestUnit(node)
    const el = unit?.members[0]
    if (!current || !unit || !el?.contains(node)) return undefined
    const range = el.ownerDocument.createRange()
    range.selectNodeContents(el)
    range.setEnd(node, offset)
    const oldText = el.textContent ?? ''
    const at = node instanceof Element ? node : node.parentElement
    return {
      start: unit.start,
      end: unit.end,
      rel: range.toString().length,
      positional: oldText === current.text.slice(unit.start, unit.end),
      inMarker: at?.closest('.vditor-ir__marker') != null,
      overlapFrom: -1,
      overlapTo: -1,
      oldText,
      hunks: { oldStarts: [], oldEnds: [], newStarts: [], newEnds: [] },
    }
  }

  /** Moves a saved point by one rendered group. */
  const movePointBy = (point: SavedPoint, move: GroupMove): void => {
    const delta = move.newLength - move.oldLength
    if (point.overlapFrom >= 0) {
      if (move.from < point.overlapFrom) {
        point.overlapFrom += delta
        point.overlapTo += delta
      }
      return
    }
    if (move.from < point.start) {
      // H2 fix design rev2 (D1.1): a group that begins before the unit and reaches into it rewrote the
      // unit's start, so the point lands at the group's edge, not at a shifted unit offset.
      if (move.from + move.oldLength > point.start) {
        point.overlapFrom = move.from
        point.overlapTo = move.from + move.newLength
        return
      }
      point.start += delta
      point.end += delta
    } else if (move.from <= point.end) {
      const local = move.from - point.start
      point.hunks.oldStarts.push(local)
      point.hunks.oldEnds.push(local + move.oldLength)
      point.hunks.newStarts.push(local)
      point.hunks.newEnds.push(local + move.newLength)
      point.end += delta
    }
  }

  /** Moves a saved point by the groups rendered since index `from` (in their order). */
  const movePoint = (
    point: SavedPoint,
    moves: readonly GroupMove[],
    from: number,
  ): void => {
    for (let i = from; i < moves.length; i++) movePointBy(point, moves[i])
  }

  /** The deepest unit that starts at or before `R` offset `offset` (a saved point's unit start). */
  const unitAt = (offset: number): U | undefined =>
    model ? deepestUnitAt(model, offset) : undefined

  /**
   * The live endpoint of a moved point: positional when proven, else the rendered-difference rule, else
   * the unsliced restore's (2.7, D1.2). `isRedo` is the move's direction (H2 fix design rev2, D1.1).
   */
  const endpointOf = (
    point: SavedPoint,
    isRedo: boolean,
  ): { node: Node; offset: number } | null => {
    const current = model
    if (!current) return null
    if (point.overlapFrom >= 0) return overlapEndpoint(current, point, isRedo)
    const unit = unitAt(point.start)
    const el = unit?.members[0]
    if (!unit || !el) return null
    const caret = replayUnitCaret(
      {
        offset: point.rel,
        oldRendered: point.oldText,
        oldSource: point.positional ? point.oldText : '',
        newRendered: el.textContent ?? '',
        newSource: current.text.slice(unit.start, unit.end),
        hunks: point.hunks,
        isRedo,
        previousText: point.oldText,
        restored: [el],
      },
      replayCounts,
    )
    if (caret.kind === 'unsliced') return caret.endpoint
    return textPoint(el, caret.offset, point.inMarker)
  }

  /** A point whose unit start a group rewrote: the group's new start (Undo) or end (Redo). */
  const overlapEndpoint = (
    current: TextModel<HTMLElement>,
    point: SavedPoint,
    isRedo: boolean,
  ): { node: Node; offset: number } | null => {
    const at = isRedo ? point.overlapTo : point.overlapFrom
    const landed = unitAt(at)
    const host = landed?.members[0]
    if (!landed || !host) return null
    const positional =
      host.textContent === current.text.slice(landed.start, landed.end)
    return textPoint(host, positional ? at - landed.start : 0, point.inMarker)
  }

  /**
   * H2 fix design rev2 (D1.1): one selection endpoint kept across a replay atomic. `saved`: it lies in a
   * replaced element and is mapped through the render; `end`: an element point after the window in the
   * replaced elements' parent (a root selection's end), kept at its distance from the parent's end;
   * `live`: it is outside the window and is written back unchanged.
   */
  type KeptEnd =
    | { kind: 'saved'; point: SavedPoint }
    | { kind: 'end'; node: Node; rest: number }
    | { kind: 'live'; node: Node; offset: number }
  let keptSelection: { anchor: KeptEnd; focus: KeptEnd } | undefined

  /** Where an endpoint lies against the replaced elements: inside one, after the window in their parent, or neither. */
  const replacedSide = (
    node: Node,
    offset: number,
    replace: readonly HTMLElement[],
  ): 'inside' | 'after' | undefined => {
    for (const el of replace) if (el.contains(node)) return 'inside'
    const first = replace[0]
    if (!first || node !== first.parentNode || offset === 0) return undefined
    let index = 0
    for (let c = first.previousSibling; c; c = c.previousSibling) index++
    return offset > index ? 'after' : undefined
  }

  const keptEnd = (
    node: Node,
    offset: number,
    side: 'inside' | 'after' | undefined,
    replace: readonly HTMLElement[],
  ): KeptEnd => {
    if (side === undefined) return { kind: 'live', node, offset }
    if (side === 'after')
      return { kind: 'end', node, rest: node.childNodes.length - offset }
    const point = savePoint(node, offset)
    if (point) return { kind: 'saved', point }
    // No unit holds the inside point: it lands right after the new window.
    const last = replace[replace.length - 1]
    const parent = last.parentNode
    if (!parent) return { kind: 'live', node, offset }
    let rest = 0
    for (let c = last.nextSibling; c; c = c.nextSibling) rest++
    return { kind: 'end', node: parent, rest }
  }

  /** Reads the selection before a replay atomic replaces `replace`; nothing is kept (or allocated) when no endpoint is affected. */
  const keepSelectionAcross = (replace: readonly HTMLElement[]): void => {
    const root = deps.getRoot()
    const selection = root?.ownerDocument.getSelection()
    const anchorNode = selection?.anchorNode
    const focusNode = selection?.focusNode
    if (!selection || !anchorNode || !focusNode || replace.length === 0) return
    const anchorSide = replacedSide(anchorNode, selection.anchorOffset, replace)
    const focusSide = replacedSide(focusNode, selection.focusOffset, replace)
    if (anchorSide === undefined && focusSide === undefined) return
    keptSelection = {
      anchor: keptEnd(anchorNode, selection.anchorOffset, anchorSide, replace),
      focus: keptEnd(focusNode, selection.focusOffset, focusSide, replace),
    }
  }

  const resolveKept = (
    end: KeptEnd,
    move: GroupMove,
    isRedo: boolean,
  ): { node: Node; offset: number } | null => {
    if (end.kind === 'live') return end
    if (end.kind === 'end')
      return {
        node: end.node,
        offset: Math.max(0, end.node.childNodes.length - end.rest),
      }
    movePointBy(end.point, move)
    return endpointOf(end.point, isRedo)
  }

  /** Writes the kept selection once after the atomic of group `[from, from + oldLength)`, direction and affinity kept. */
  const restoreKeptSelection = (
    from: number,
    oldLength: number,
    newLength: number,
    isRedo: boolean,
  ): void => {
    const kept = keptSelection
    keptSelection = undefined
    if (!kept) return
    const move = { from, oldLength, newLength }
    const anchor = resolveKept(kept.anchor, move, isRedo)
    const focus = resolveKept(kept.focus, move, isRedo)
    if (!anchor || !focus) return
    // Through the caret authority's helper, so an armed caret intent is kept (selection-writes rule).
    writeSelectionKeepingIntent({
      anchorNode: anchor.node,
      anchorOffset: anchor.offset,
      focusNode: focus.node,
      focusOffset: focus.offset,
    })
  }

  /** Task 733 / 036 (step C, 2.6): renders the pending groups at the endpoints and keeps the selection. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the endpoints render in document order, the points move with each render and the selection is put back once
  function beforeReplayInput(event: Event): void {
    // H2 fix design rev2 (D3.1-D3.4, D2): Cut, Copy and an expanded deletion are one proven transaction,
    // read from the selection before any render.
    if (event.type === 'beforecut' || event.type === 'beforecopy') {
      clipboardBefore(event)
      return
    }
    if (event.type === 'cut' || event.type === 'copy') {
      clipboardEvent(event as ClipboardEvent)
      return
    }
    if (selectionDelete(event)) {
      guardedDelete(event)
      return
    }
    const logical = replayLogical
    const root = deps.getRoot()
    if (!logical || !model || !dom || !root) return
    absorbReplay(postLogicalDelta)
    if (replayLogical !== logical) return
    const selection = root.ownerDocument.getSelection()
    const anchorNode = selection?.anchorNode
    const focusNode = selection?.focusNode
    if (!selection || !anchorNode || !focusNode) return
    if (!root.contains(anchorNode) || !root.contains(focusNode)) return
    const collapsed = selection.isCollapsed
    const points: SavedPoint[] = []
    const anchor = savePoint(anchorNode, selection.anchorOffset)
    const focus = savePoint(focusNode, selection.focusOffset)
    if (!anchor || !focus) return
    points.push(anchor, focus)
    if (event.type === 'drop') {
      const drag = event as DragEvent
      const at = (
        root.ownerDocument as Document & {
          caretRangeFromPoint?: (x: number, y: number) => Range | null
        }
      ).caretRangeFromPoint?.(drag.clientX, drag.clientY)
      const dropped =
        at && root.contains(at.startContainer)
          ? savePoint(at.startContainer, at.startOffset)
          : undefined
      if (dropped) points.push(dropped)
    }
    const key = event.type === 'keydown' ? (event as KeyboardEvent).key : ''
    const moves: GroupMove[] = []
    const order = [...points].sort((a, b) => a.start - b.start)
    for (const point of order) {
      const done = moves.length
      // Backspace and Delete also reach the neighbouring unit on their side (2.6 table, row 1).
      const from =
        key === 'Backspace' ? Math.max(0, point.start - 1) : point.start
      const to = key === 'Delete' ? point.end + 1 : point.end
      // D6.1: abandoned, an input whose endpoint needs a render is refused; the DOM keeps its bytes.
      if (exactAbandoned && pendingIn(from, to)) {
        replayCounts.abandonRefused++
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (!renderTouching(from, to, moves)) {
        emitReplayFrame()
        failReplayInput()
        return
      }
      for (const other of points) movePoint(other, moves, done)
    }
    emitReplayFrame()
    if (moves.length > 0) {
      const a = endpointOf(anchor, logical.isRedo)
      const f = endpointOf(focus, logical.isRedo)
      // Through the caret authority's helper, so an armed caret intent is kept (selection-writes rule).
      if (a && f)
        writeSelectionKeepingIntent({
          anchorNode: a.node,
          anchorOffset: a.offset,
          focusNode: f.node,
          focusOffset: f.offset,
        })
    }
    // 036 core C4 (M1, R2.1): admitted on the prepared range, after the endpoint groups rendered (the
    // endpoint render stays: it wrote the target's bytes, not user bytes).
    if (!admitSelection(root)) {
      refuseReplayInput(event)
      return
    }
    const expanded = !collapsed || points.length > 2
    // 036 core C5 (R33.2): the composition's start range in `R`, after the endpoint renders.
    if (
      event.type === 'compositionstart' &&
      composition &&
      !composition.released
    ) {
      composition.range = {
        rFrom: Math.min(points[0].start, points[1].start),
        rTo: Math.max(points[0].end, points[1].end),
      }
      composition.typedAtStart = replayCounts.typed
      composition.lengthAtStart = model.text.length
    }
    if (
      needsInputIntent(event.type, !expanded) ||
      (expanded && isEditingKeyName(key))
    ) {
      let rFrom = points[0].start
      let rTo = points[0].end
      for (const point of points) {
        rFrom = Math.min(rFrom, point.start)
        rTo = Math.max(rTo, point.end)
      }
      const previous = logical.intent
      logical.intent = previous
        ? {
            rFrom: Math.min(previous.rFrom, rFrom),
            rTo: Math.max(previous.rTo, rTo),
          }
        : { rFrom, rTo }
      replayCounts.intents++
    }
    // 036 core C4 (M1, R2.1): rechecked immediately before the user write, which follows this handler.
    if (!admitSelection(root)) refuseReplayInput(event)
  }

  /** 036 core C4 (M1): the admission of the current selection in `root`. */
  function admitSelection(root: HTMLElement): boolean {
    const selection = root.ownerDocument.getSelection()
    const anchorNode = selection?.anchorNode
    const focusNode = selection?.focusNode
    if (!anchorNode || !focusNode) return replayAcceptsInput(EMPTY_RANGE)
    ADMIT_RANGE.startContainer = anchorNode
    ADMIT_RANGE.endContainer = focusNode
    const ok = replayAcceptsInput(ADMIT_RANGE)
    ADMIT_RANGE.startContainer = ADMIT_RANGE.endContainer = EMPTY_NODE
    return ok
  }

  // ---- H2 fix design rev2 (D3.1-D3.4, D2): Cut, Copy and an expanded deletion during a replay ----

  /**
   * One proven logical range, read from the selection before any render (D3.2): the range in `R` and `L`
   * (a line copy or cut takes the line's terminator), its clipboard text `L.slice(lFrom, lTo)`, and what
   * revalidates it at the event (D3.3).
   */
  type ClipboardProof = {
    logical: NonNullable<typeof replayLogical>
    epoch: number | undefined
    lLength: number
    anchorNode: Node
    anchorOffset: number
    focusNode: Node
    focusOffset: number
    rFrom: number
    rTo: number
    lFrom: number
    lTo: number
    text: string
  }
  // The `beforecut` or `beforecopy` of the event in flight: its proof, or none (a refusal the event
  // keeps). Taken once by the event; a timer drops one whose event never came.
  let clipboardToken:
    | { type: 'cut' | 'copy'; proof: ClipboardProof | undefined }
    | undefined
  // The deletion event last handled (a second delivery of it is cancelled), and the key's pending
  // `beforeinput` (cancelled when a deletion already ran for its `keydown`), until the next task.
  let lastDeletion: Event | undefined
  let deletionKeyPending = false

  /** The replay's logical text is live, or the recovery renders the host text (D3.1, D3.4). */
  const replayGuarded = (): boolean =>
    replayLogical !== undefined || recovery !== undefined

  const targetInRoot = (event: Event): boolean => {
    const root = deps.getRoot()
    return event.target instanceof Node && root?.contains(event.target) === true
  }

  /** A table rectangle owns its Copy, Cut and Delete (2.6 table rows). */
  const rectangleSelected = (): boolean =>
    deps.getRoot()?.querySelector('.vmde-cell-selected') != null

  /** Backspace or Delete (not Shift+Delete, a Cut) or a selection-delete input over an expanded selection. */
  const selectionDelete = (event: Event): boolean => {
    if (event.type === 'keydown') {
      const key = event as KeyboardEvent
      if (key.key !== 'Backspace' && !(key.key === 'Delete' && !key.shiftKey))
        return false
    } else if (
      event.type !== 'beforeinput' ||
      !SELECTION_DELETE_INPUTS.has((event as InputEvent).inputType)
    )
      return false
    if (deletionKeyPending && event.type === 'beforeinput') return true
    return deps.getRoot()?.ownerDocument.getSelection()?.isCollapsed === false
  }

  /** The exact `R` offset of a selection endpoint (D3.2 cases 1-3), else undefined. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the root, unit-boundary and positional proofs are the three cases of one rule
  function provenR(
    node: Node,
    offset: number,
    root: HTMLElement,
    current: TextModel<HTMLElement>,
  ): number | undefined {
    if (node === root) {
      if (offset === 0) return 0
      return offset === root.childNodes.length ? current.text.length : undefined
    }
    if (node instanceof Element) {
      const unit = current.unitOf(node as HTMLElement)
      if (!unit || unit.members[0] !== node) return undefined
      if (offset === 0) return unit.start
      return offset === node.childNodes.length ? unit.end : undefined
    }
    const unit = nearestUnit(node)
    const el = unit?.members[0]
    if (!unit || !el?.contains(node) || node.nodeType !== Node.TEXT_NODE)
      return undefined
    if (el.textContent !== current.text.slice(unit.start, unit.end))
      return undefined
    const range = el.ownerDocument.createRange()
    range.selectNodeContents(el)
    range.setEnd(node, offset)
    return unit.start + range.toString().length
  }

  /** The proof of the live selection, or undefined (D3.2); reads, writes nothing. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the line proof and the range proof share the endpoint, translation and limit checks
  function proofOf(
    kind: 'cut' | 'copy' | 'delete',
    logical: NonNullable<typeof replayLogical>,
    current: TextModel<HTMLElement>,
    root: HTMLElement,
  ): ClipboardProof | undefined {
    const selection = root.ownerDocument.getSelection()
    const anchorNode = selection?.anchorNode
    const focusNode = selection?.focusNode
    if (!selection || !anchorNode || !focusNode) return undefined
    if (!root.contains(anchorNode) || !root.contains(focusNode))
      return undefined
    const text = current.text
    let rFrom: number
    let rTo: number
    if (selection.isCollapsed) {
      // A line copy or cut: the caret's leaf unit, found from a text point (an element caret has no proof).
      if (kind === 'delete' || anchorNode.nodeType !== Node.TEXT_NODE)
        return undefined
      const unit = nearestUnit(anchorNode)
      if (!unit?.members[0]?.contains(anchorNode)) return undefined
      // The line and its one terminator: a following block keeps its blank line (no lazy continuation).
      rFrom = unit.start
      rTo = text.charCodeAt(unit.end) === 10 ? unit.end + 1 : unit.end
    } else {
      const a = provenR(anchorNode, selection.anchorOffset, root, current)
      const f = provenR(focusNode, selection.focusOffset, root, current)
      if (a === undefined || f === undefined || a === f) return undefined
      rFrom = Math.min(a, f)
      rTo = Math.max(a, f)
    }
    const { state } = logical
    const lFrom = state.rToL(rFrom)
    const lTo = state.rToL(rTo)
    if (typeof lFrom !== 'number' || typeof lTo !== 'number') return undefined
    // The host refuses a delta whose `oldText` exceeds its limit: refused before anything is written.
    if (kind !== 'copy' && lTo - lFrom > DELTA_TEXT_LIMIT) return undefined
    return {
      logical,
      epoch: host?.epoch,
      lLength: state.logicalLength(),
      anchorNode,
      anchorOffset: selection.anchorOffset,
      focusNode,
      focusOffset: selection.focusOffset,
      rFrom,
      rTo,
      lFrom,
      lTo,
      text: state.logicalSlice(text, lFrom, lTo),
    }
  }

  /** Publishes pending typing first, then proves the selection; undefined while the recovery runs (D3.4). */
  function captureProof(
    kind: 'cut' | 'copy' | 'delete',
  ): ClipboardProof | undefined {
    const logical = replayLogical
    const root = deps.getRoot()
    if (!logical || !model || !dom || !root || recovery) return undefined
    if (deps.isComposing()) return undefined
    absorbReplay(postLogicalDelta)
    const current = model
    if (replayLogical !== logical || !current || current.hasDirty())
      return undefined
    return proofOf(kind, logical, current, root)
  }

  /** Equal-length edits keep the generation, epoch and length: the endpoints and the bytes are compared too. */
  const sameProof = (a: ClipboardProof, b: ClipboardProof): boolean =>
    a.logical === b.logical &&
    a.epoch === b.epoch &&
    a.lLength === b.lLength &&
    a.anchorNode === b.anchorNode &&
    a.anchorOffset === b.anchorOffset &&
    a.focusNode === b.focusNode &&
    a.focusOffset === b.focusOffset &&
    a.rFrom === b.rFrom &&
    a.rTo === b.rTo &&
    a.lFrom === b.lFrom &&
    a.lTo === b.lTo &&
    a.text === b.text

  /**
   * The guarded deletion of a proof, checked before anything is written (plan and render preflight);
   * the returned commit runs it once. A whole range takes the empty-model path (D2).
   */
  function prepareDeletion(proof: ClipboardProof): (() => void) | undefined {
    const current = model
    const root = deps.getRoot()
    if (!current || !dom || !root || replayLogical !== proof.logical)
      return undefined
    if (proof.rFrom === 0 && proof.rTo === current.text.length)
      return () => deleteWhole(proof, current, root)
    const raw = [{ from: proof.rFrom, to: proof.rTo, insert: '' }]
    const prepared = prepareApply(raw)
    if (!('commit' in prepared)) return undefined
    return () => {
      const before = current.text
      const hint = lineHint(current, proof.rFrom)
      const applied = commitPrepared(prepared, false, false)
      if (applied.outcome.kind !== 'applied') {
        failReplayInput()
        return
      }
      publishDeletion(proof, current, before, raw, hint)
      const unit = deepestUnitAt(current, proof.rFrom)
      const el = unit?.members[0]
      if (!unit || !el) return
      const positional =
        el.textContent === current.text.slice(unit.start, unit.end)
      const at = textPoint(
        el,
        positional ? Math.min(proof.rFrom, unit.end) - unit.start : 0,
      )
      writeSelectionKeepingIntent({
        anchorNode: at.node,
        anchorOffset: at.offset,
        focusNode: at.node,
        focusOffset: at.offset,
      })
    }
  }

  /**
   * D2: the whole range leaves one empty paragraph, as the whole-document handler does, and the model
   * text becomes `''` with it; the host gets one deletion of all of `L`.
   */
  function deleteWhole(
    proof: ClipboardProof,
    current: TextModel<HTMLElement>,
    root: HTMLElement,
  ): void {
    const before = current.text
    const raw = [{ from: 0, to: before.length, insert: '' }]
    capture.onBatch(new Set(), new Set(['root']))
    const paragraph = root.ownerDocument.createElement('p')
    paragraph.setAttribute('data-block', '0')
    // The model takes the write itself (rebind below): its records are not typing.
    const write = () => root.replaceChildren(paragraph)
    if (dom?.writeOwn) dom.writeOwn(write)
    else write()
    current.rebind('')
    if (current.state !== 'live') {
      failReplayInput()
      return
    }
    emitWhole('sync')
    restartSoon()
    publishDeletion(proof, current, before, raw, undefined)
    writeSelectionKeepingIntent({
      anchorNode: paragraph,
      anchorOffset: 0,
      focusNode: paragraph,
      focusOffset: 0,
    })
  }

  /** The one replay operation of a guarded deletion: the saved pre-edit `R` change, translated once. */
  function publishDeletion(
    proof: ClipboardProof,
    current: TextModel<HTMLElement>,
    before: string,
    raw: readonly TextChange[],
    hint: { offset: number; line: number } | undefined,
  ): void {
    const changes = translateChanges(proof.logical, before, raw, hint)
    if (changes?.length !== 1) {
      failReplayInput()
      return
    }
    replayCounts.deletes++
    postLogicalDelta(changes, recoveryProofOf(current, before, raw, changes))
  }

  /** Cancels an event and its default action (no other listener runs, nothing is written). */
  const cancelEvent = (event: Event): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  /** D3.3 step 4: the clipboard keeps what it held and the document is unchanged. Counted only. */
  const refuseClipboard = (event: Event): void => {
    cancelEvent(event)
    replayCounts.clipboardRefused++
  }

  /** D3.1: `beforecut` or `beforecopy` captures the proof before the line expansion or any render. */
  function clipboardBefore(event: Event): void {
    clipboardToken = undefined
    if (!replayGuarded() || !targetInRoot(event)) return
    // During the recovery the refusal comes first; otherwise a rectangle keeps its own handlers.
    if (!recovery && rectangleSelected()) return
    const type = event.type === 'beforecut' ? 'cut' : 'copy'
    const token = { type, proof: captureProof(type) } as const
    clipboardToken = token
    deps.setTimeout(() => {
      if (clipboardToken === token) clipboardToken = undefined
    }, 0)
    // Cancelling the before-event also enables a collapsed Cut or Copy, so the event arrives here.
    cancelEvent(event)
  }

  /** D3.3: the event takes its token once, revalidates the proof, writes `L.slice` and deletes once. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the token, the revalidation, the preflight and the writes are one transaction
  function clipboardEvent(event: ClipboardEvent): void {
    const token = clipboardToken
    clipboardToken = undefined
    if (!targetInRoot(event)) return
    if (!token) {
      // A missing before-event: refused while guarded, never handed to the native handlers.
      if (!replayGuarded() || (!recovery && rectangleSelected())) return
      refuseClipboard(event)
      return
    }
    const proof = token.proof
    const current = model
    const root = deps.getRoot()
    dom?.drain()
    const again =
      proof &&
      current &&
      root &&
      token.type === event.type &&
      replayLogical === proof.logical &&
      !recovery &&
      !current.hasDirty()
        ? proofOf(token.type, proof.logical, current, root)
        : undefined
    if (!proof || !again || !sameProof(proof, again) || !event.clipboardData) {
      refuseClipboard(event)
      return
    }
    const deletion = event.type === 'cut' ? prepareDeletion(proof) : undefined
    if (event.type === 'cut' && !deletion) {
      refuseClipboard(event)
      return
    }
    cancelEvent(event)
    event.clipboardData.setData('text/plain', proof.text)
    replayCounts.clipboard++
    deletion?.()
  }

  /** D3.3 and D2: Backspace or Delete over an expanded selection is one guarded deletion, or refused. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the duplicate, rectangle, proof and preflight gates come before the one deletion
  function guardedDelete(event: Event): void {
    if (!targetInRoot(event)) return
    // A second delivery, or the input of a key whose deletion ran (even when it ended the replay).
    if (
      event === lastDeletion ||
      (deletionKeyPending && event.type === 'beforeinput')
    ) {
      cancelEvent(event)
      return
    }
    if (!replayGuarded()) return
    lastDeletion = event
    if (!recovery && rectangleSelected()) return
    const proof = recovery ? undefined : captureProof('delete')
    const deletion = proof ? prepareDeletion(proof) : undefined
    cancelEvent(event)
    if (!deletion) {
      replayCounts.deleteRefused++
      return
    }
    if (event.type === 'keydown') {
      deletionKeyPending = true
      deps.setTimeout(() => {
        deletionKeyPending = false
      }, 0)
    }
    deletion()
  }

  /** Task 733 / 036 (step C, 2.7): the caret intent's group renders before an input that arrives first. */
  function renderReplayCaretGroup(): void {
    const logical = replayLogical
    // D6.1: an abandoned replay renders nothing more.
    if (!logical || logical.caretGroup < 0 || exactAbandoned) return
    if (!logical.state.isPending(logical.caretGroup)) return
    absorbReplay(postLogicalDelta)
    if (replayLogical !== logical) return
    const r = { from: 0, to: 0 }
    logical.state.rangeR(logical.caretGroup, r)
    const moves: GroupMove[] = []
    const ok = renderTouching(r.from, r.to, moves)
    emitReplayFrame()
    if (!ok) failReplayInput()
  }

  /** Task 733 / 036 (step C, 2.6): an untagged Undo or Redo during a replay, reserved at the key. */
  function publishReplayHistory(
    kind: 'undo' | 'redo',
    steps: number,
  ): 'delta' | 'nothing' {
    const sync = replaySync
    if (!replayLogical || !sync) return 'nothing'
    const reservation = sync.reserveReplayHistory(kind)
    if (!reservation) {
      failReplayInput()
      return 'nothing'
    }
    replayCounts.reserved++
    let posted = false
    absorbReplay((changes) => {
      posted = true
      sync.postReservedHistory(reservation, kind, steps, changes)
    })
    if (!posted) sync.postReservedHistory(reservation, kind, steps, [])
    return 'delta'
  }

  /** Task 733 / 036 (step C, 2.6): the logical bytes of a table, its pending groups rendered first. */
  function replayTableSource(table: HTMLElement): string | undefined {
    const logical = replayLogical
    const current = model
    if (!logical || !current) return undefined
    absorbReplay(postLogicalDelta)
    if (replayLogical !== logical) return undefined
    const unit = current.units.find(
      (candidate) =>
        candidate.kind === 'table' && candidate.members[0] === table,
    )
    if (!unit) return undefined
    const moves: GroupMove[] = []
    const ok = renderTouching(unit.start, unit.end, moves)
    emitReplayFrame()
    if (!ok) {
      failReplayInput()
      return undefined
    }
    const lFrom = logical.state.rToL(unit.start)
    const lTo = logical.state.rToL(unit.end)
    if (typeof lFrom !== 'number' || typeof lTo !== 'number') return undefined
    return logical.state.logicalSlice(current.text, lFrom, lTo)
  }

  /** Task 733 / 036 (step C, 2.4 step 3): the `L` offset of the caret intent, else the change site (0). */
  function caretIntentOffset(
    state: ReplayTarget,
    built: TextModel<HTMLElement>,
  ): number {
    const root = deps.getRoot()
    const focus = root?.ownerDocument.getSelection()?.focusNode
    if (!root || !focus || !root.contains(focus)) return 0
    const unit = nearestUnit(focus)
    if (!unit || model !== built) return 0
    const l = state.rToL(unit.start)
    return typeof l === 'number' ? l : 0
  }

  // Task 733 / 036 (F8): the port with the session's join around the sliced restore. The reply and the
  // final slice may arrive in either order; the rebind runs only after both.
  const slicedPort = (port: HistoryModelPort): HistoryModelPort => {
    const sliced = port.restoreSliced
    if (!sliced) return port
    return {
      ready: () => port.ready(),
      claimable: () => port.claimable(),
      pending: () => port.pending(),
      capture: () => port.capture(),
      restore: (c, side, caret) => port.restore(c, side, caret),
      restoreSliced: async (c, side, budgetMs) => {
        const sequence = exactPending
        exactSlicing++
        let ok = false
        try {
          // Task 733 / 036 (step B): the replay engine first; today's sliced restore when it cannot run.
          const engine = startReplay(side)
          if (engine !== undefined) ok = await engine
          else {
            replayCounts.whole++
            ok = await sliced(c, side, budgetMs)
          }
        } finally {
          exactSlicing--
        }
        if (sequence === undefined || exactPending !== sequence) return ok
        if (!ok) {
          abandonExact(sequence)
          return ok
        }
        settleRestored()
        if (exactReply) finishExactReply(exactReply)
        return ok
      },
    }
  }

  /**
   * Task 733 / 036 (step B, 4.3): one scoped change for every replay write of the frame. H2 fix design rev2
   * (D9.2, D9.3): the emission and its listeners are timed as replay work: inside a frame they add to the
   * frame's work and its miss test, outside one they are one charged region.
   */
  function emitReplayFrame(): void {
    if (replayFrameWrites.length === 0) return
    replayBudget.charged(emitReplayWrites, false, 'emission')
    // D8.1: a replay write outside a replay or a recovery (an input's endpoint render after the last
    // group, a reapplied edit) leaves no later point to render the outline at.
    if (!replayRun && !recovery) scheduleOutline()
  }

  /**
   * H2 fix design rev2 (D8.1): one deferred outline render for the heading writes of replays, in its own
   * task, timed as the `outline` class (it can exceed 50 ms on a large outline: it is measured, not
   * assumed). Nothing is scheduled when no replay write skipped the outline.
   */
  function scheduleOutline(): void {
    const unitDom = dom
    if (outlineScheduled || !unitDom?.outlinePending?.()) return
    outlineScheduled = true
    replayBudget.expect()
    deps.setTimeout(() => {
      outlineScheduled = false
      // S4 repair (fix 9): nothing after teardown or a rebuild over a new adapter (the mark is still released).
      replayBudget.charged(
        () => {
          if (dom === unitDom && live()) unitDom.flushOutline?.()
        },
        true,
        'outline',
      )
    }, 0)
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each write's units and scopes are read at the frame's end and merged without duplicates
  function emitReplayWrites(): void {
    const root = deps.getRoot()
    const changed: LiveUnit[] = []
    const scopes: HTMLElement[] = []
    for (const write of replayFrameWrites) {
      // Read at the frame's end: a unit a later atomic replaced is no longer listed.
      let units = write.table
        ? [toLiveUnit(write.table, root)]
        : liveUnitsOf(
            write.rendered.map((listed) => listed.members[0]),
            root,
          )
      if (units.length === 0) units = liveUnitsOf(write.neighbours, root)
      for (const unit of units) if (!changed.includes(unit)) changed.push(unit)
      for (const scope of appliedScopes(
        write.rendered,
        units,
        write.table !== undefined,
      ))
        if (!scopes.includes(scope)) scopes.push(scope)
    }
    replayFrameWrites.length = 0
    emit({
      cause: 'sync',
      whole: changed.length === 0,
      changed,
      structural: [],
      scopes: scopes.length > 0 ? scopes : NO_SCOPES,
    })
  }

  /**
   * Task 733 / 036 (fix design 2.2): the idle work of a confirmed Find record. The normalized hunks are
   * computed once (`exactHunksOf` keeps them on the record), then every group's `planApply` is run dry
   * against the model text, which still holds the Replace result; a group whose plan falls back (also with
   * definition references allowed) marks the record, so its Undo takes today's path at the key. A model
   * text that moved on (typing after the Replace) ends the check with nothing marked.
   */
  const hunkJob: BackgroundJob = {
    name: 'find-hunks',
    lane: 'idle',
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the record cursor, the model gate and the budgeted dry-run loop are one idle step
    step(budget) {
      while (hunkQueue.length > 0) {
        const requestId = hunkQueue[0]
        const check = hunkChecks.get(requestId)
        const hunks = check
          ? (deps.exactHunksOf ?? exactHistoryHunks)(requestId)?.normalized
          : undefined
        const current = model
        if (
          !check ||
          !hunks?.incremental ||
          !current ||
          !live() ||
          builtMode === 'sv' ||
          current.text !== hunks.after
        ) {
          // 036 S5.2: a text gate failure leaves nothing known, so it is `skipped`, not completed.
          if (check) check.state = 'skipped'
          hunkQueue.shift()
          continue
        }
        // A key that arrives while this check yields reads `running` and counts it interrupted.
        if (check.state !== 'interrupted') check.state = 'running'
        check.total = hunks.newStarts.length
        while (check.next < hunks.newStarts.length) {
          if (budget.spent()) return true
          const i = check.next++
          const changes = [
            {
              from: hunks.newStarts[i],
              to: hunks.newEnds[i],
              insert: hunks.before.slice(hunks.oldStarts[i], hunks.oldEnds[i]),
            },
          ]
          let planned = current.planApply(changes)
          if (
            planned.kind === 'fallback' &&
            planned.reason === 'dependent-construct'
          )
            planned = withDefinitionReferences(() => current.planApply(changes))
          // Pending typing (a dirty overlap) says nothing about the record; the render retries it.
          if (
            planned.kind === 'fallback' &&
            planned.reason !== 'dirty-overlap'
          ) {
            if (check.refused === 0) check.reason = planned.reason
            check.refused++
          }
        }
        check.state = 'completed'
        hunkQueue.shift()
      }
      return false
    },
  }
  const scheduleHunkCheck = (requestId: string): void => {
    if (hunkChecks.has(requestId)) return
    hunkChecks.set(requestId, {
      state: 'pending',
      next: 0,
      total: 0,
      refused: 0,
      reason: undefined,
    })
    hunkQueue.push(requestId)
    // Bounded: only the most recent records are kept (Find keeps 50; the newest matter for Undo).
    if (hunkChecks.size > 8) {
      const oldest = hunkChecks.keys().next().value as string
      hunkChecks.delete(oldest)
      const at = hunkQueue.indexOf(oldest)
      if (at >= 0) hunkQueue.splice(at, 1)
    }
    backgroundSchedulerOf(deps.win).post(hunkJob)
  }

  /**
   * Task 733 / 036: the pair fields are read before the matched-sequence check, so a superseded answer
   * still confirms its pair.
   */
  const notePairFields = (message: RebindMessage): void => {
    if (typeof message.exactRequestId === 'string') {
      deps.confirmExactHistory?.(message.exactRequestId)
      scheduleHunkCheck(message.exactRequestId)
    }
    if (typeof message.exactEvicted === 'string')
      deps.evictExactHistory?.(message.exactEvicted)
  }
  /** Task 733 / 036 (F8): the matched answer to the exact replay, joined with the final slice. */
  const answerExact = (content: string, epoch: number): boolean => {
    if (exactPending === undefined || exactPending !== awaited) return false
    awaited = undefined
    prediction = undefined
    const reply = { content, epoch }
    if (exactSlicing > 0) {
      exactReply = reply
      clearExactWatchdog()
    } else finishExactReply(reply)
    return true
  }

  const finishAnswer = (content: string, epoch: number): void => {
    host = { text: content, epoch }
    stale = false
    if (held && keptBeforePost !== undefined) {
      // Task 733 / 022 (Q-183): the restored DOM renders the kept text, not `content`. The transition
      // goes out with the host bytes; the model builds from the kept text with no `rebind` pairing.
      const { kind, publish } = held
      const after = keptBeforePost
      held = undefined
      keptBeforePost = undefined
      const sequence = publish({ kind, before: content, after })
      if (sequence !== undefined) awaited = sequence
      cancelBuild()
      buildKept({ text: after, epoch })
      return
    }
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
      // Task 733 / 013: the served mode of the live model (kinds only, SR-5).
      mode: live() ? builtMode : undefined,
      units: treeStats?.units ?? 0,
      proven: treeStats?.proven ?? 0,
      opaque: treeStats?.opaque ?? 0,
      dirtyNow: model ? countDirty(model.units) : 0,
      // Task 733 / 036 (T0): pending structure windows, which `dirtyNow` (unit flags only) misses.
      structureDirty: model ? modelInternals(model).structure.size : 0,
      ...shadow,
      fallbacks: { ...fallbacks },
      auditMismatch: treeStats?.auditMismatch ?? 0,
      heldHistoryRefusals,
      // Task 733 / 036 (step B): replay engine counts and the budget account (kinds and numbers only).
      replay: {
        ...replayCounts,
        recovery: { ...recoveryCounts },
        lastRefusal,
        // 036 S5.2: dry-run states at the key and the routes to the sliced restore.
        dryRun: { ...dryRunCounts },
        lastDryRun,
        route: { ...routeCounts },
        budget: replayBudget.stats(),
        deliveryAbsorbMs: Array.from(
          deliveryAbsorbMs.subarray(
            0,
            Math.min(deliveryAbsorbAt, DELIVERY_SAMPLES),
          ),
        ),
      },
    }
  }

  // Task 733 / 036 (T0): each publication trace entry records the touched proof and the structure state.
  const traceContextReader = () => ({
    touched: touchedProof,
    structureDirty: model ? modelInternals(model).structure.size : 0,
  })
  if (deps.e2e) {
    setPublicationTraceContext(traceContextReader)
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
    keptBeforePost = undefined
  }

  /** A whole-text publication that is not predicted: the model clears its flags and awaits the host bytes. */
  const unshadowedPost = (
    current: TextModel<HTMLElement>,
    sequence: number,
  ): { rebind: true } => {
    // 036 core C6 (R2.4): a whole-text post ends the replay's ownership of the host.
    replayOwnership = undefined
    if (preTouchFallback)
      countFallback(schedule?.lastFallbackReason() ?? 'unproven-selection')
    preTouchFallback = false
    // Task 733 / 022: read before the post marks the model; the text is still the one from before it.
    // Task 733 / 036 (review point 4): a whole post of an unchanged DOM while an earlier one is awaited (the
    // preparation flush before Undo) keeps that post's kept text, so the 022 hold still takes the Undo.
    const kept =
      confirmed && !stale
        ? current.text
        : awaitingNow() && !current.hasDirty()
          ? keptBeforePost
          : undefined
    current.markPublishedWhole()
    publicationBase(sequence)
    keptBeforePost = kept
    schedule?.restart()
    return { rebind: true }
  }

  const awaitingNow = (): boolean => awaited !== undefined || awaitingWrite

  /**
   * Task 733 / 015 (D-5) and 020 (Q-164): a switch into or out of Source, or between IR and WYSIWYG,
   * keeps the host epoch when the old model owned the text and no typing was unpublished; undefined
   * otherwise (today's path: the host text is dropped).
   */
  const keptAcrossSwitch = (
    next: ServedMode | undefined,
  ): { text: string; epoch: number } | undefined => {
    if (next === undefined || !host) return undefined
    const text = ownedText()
    return text === undefined ? undefined : { text, epoch: host.epoch }
  }

  /** Task 733 / 015: the new mode's model builds from the kept text on the next frame, with no `rebind` round trip. */
  const buildKept = (kept: { text: string; epoch: number }): void => {
    host = kept
    buildFrame = deps.requestAnimationFrame(() => {
      buildFrame = undefined
      attempt()
    })
  }

  /** Task 733 / 015: the model text when the model owns it (live, confirmed, trusted, not awaiting) and no unit is dirty. */
  const ownedText = (): string | undefined => {
    if (!model || !live() || awaitingNow() || stale || !confirmed)
      return undefined
    dom?.drain()
    if (!model.hasDirty()) return model.text
    return builtMode === 'sv' && sourceDirtyKeepsText(model)
      ? model.text
      : undefined
  }

  /**
   * Task 733 / 019 (019-A3): a Text split in a Source unit (the unit engine's caret split) changes no text
   * but dirties the unit. True when at least one top unit is dirty and each dirty one still sits in the
   * Source root with its proven text; a structure change (a div replaced or inserted) dirties no unit and
   * answers false. O(units) flag reads; a text read for dirty units only.
   */
  const sourceDirtyKeepsText = (built: TextModel<HTMLElement>): boolean => {
    const root = deps.getSourceRoot?.()
    let dirtyUnits = 0
    for (const unit of built.units) {
      if (!unit.dirty) continue
      dirtyUnits++
      if (!sourceUnitKeepsText(unit, root)) return false
    }
    return dirtyUnits > 0
  }

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
    if (!servesBuiltMode()) {
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
    if (!modeReentry || !servedMode() || !domComplete) return undefined
    modeReentry = false
    awaited = sequence
    if (options?.requestId !== undefined)
      exactSequences.set(options.requestId, sequence)
    return { rebind: true }
  }

  const port: DeltaSessionPort = {
    awaitExactHistory: (sequence, replay) =>
      session.awaitExactHistory(sequence, replay),
    prepareDelta(sequence): PrepareResult {
      const refused = deltaGate()
      if (refused || !model) return refused ?? offFallback
      const before = model.text
      const result = model.sync(sequence)
      changedAtSet = true
      noteUserEditsPublished()
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
      noteUserEditsPublished()
      schedule?.restart()
    },
    clearForms(keep) {
      if (model && live()) model.clearForms(keep)
    },
  }

  const session: ModelSession = {
    replayAccount: () => replayBudget,
    onHostText(text, epoch, options) {
      // The answer to a host write this webview asked for (a Preview checkbox toggle) arrives as a
      // host text: read before the reset below.
      const answersWrite = awaitingWrite && live()
      // 036 core C5 (R3.2): a host text other than the whole render's own target ends the pending wait.
      if (
        pendingReapply &&
        (epoch !== pendingReapply.epoch ||
          normalizeEol(text) !== pendingReapply.target)
      )
        settlePendingReapply()
      // 036 core C6 (S2): a host text that ends a replay is a resync for a waiting Save.
      noteResync()
      host = { text: normalizeEol(text), epoch }
      modeReentry = false
      awaited = undefined
      awaitingWrite = false
      stale = false
      wakeSaves()
      // Task 733 / 036: a host text ends an exact wait, and the guard of an abandoned replay.
      endExactWait()
      endLogical()
      // E: a whole host text replaces a recovery still rendering; its journal is gone with the epoch.
      cancelRecovery()
      recoveryJournal = []
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
      if (!answersWrite || capture.port.pending()) invalidateCaptures()
      // The DOM is about to be (or was) rebuilt by `setValue`; with no complete edit DOM there is
      // nothing to build yet and `onEditDomComplete()` will.
      if (domComplete) buildSoon()
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the matched, host-own and exact-replay answers share one ordering
    onRebind(message) {
      // 036 core C6 (R34.3): an ordinary `rebind` answer wakes the Save waiters.
      wakeSaves()
      notePairFields(message)
      const content = normalizeEol(message.content)
      const matched =
        message.editSequence !== undefined && message.editSequence === awaited
      if (matched && answerExact(content, message.epoch)) return
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
      wakeSaves()
      if (message.status !== 'applied' || message.epoch === undefined) return
      awaited = undefined
      prediction = undefined
      if (typeof message.content !== 'string') {
        // The new text is unknown: off until the next host text. 036 core C2 (R3.3): host-driven (the host
        // wrote the document), so nothing is flushed.
        host = undefined
        teardown('host')
        confirmed = false
        offReason = 'not-mounted'
        return
      }
      host = { text: normalizeEol(message.content), epoch: message.epoch }
      if (domComplete) buildSoon()
    },
    onExactRefused(requestId) {
      // Task 733 / 036 (E): a refused history post already handed its host text to the recovery.
      if (recovery) return
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
      endExactWait()
      // The host did not write the refused bytes (or names no request, Q-15 D3): the model keeps text the
      // host does not hold, so it is untrusted until a whole-text publication brings the host bytes.
      if (live()) {
        stale = true
        confirmed = false
      }
    },
    applyText(changes, origin) {
      // Task 733 / 015: the Source host renders nothing; a host update in Source takes today's setValue.
      if (!model || !dom || !live() || !servesBuiltMode() || builtMode === 'sv')
        return APPLY_OFF
      if (origin === 'exact' && !session.ownsText()) return APPLY_OFF
      return applyNow(changes, false).outcome
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
      wakeSaves()
    },
    onSave() {
      schedule?.requestAudit(false)
    },
    turnOff(reason) {
      invalidateCaptures()
      modeReentry = false
      cancelBuild()
      // 036 core C2 (R3.3): an internal failure path (a throwing shadow call, a failed unit update): the
      // failed model publishes nothing; the whole-text path carries the DOM.
      teardown('host')
      settlePendingReapply()
      host = undefined
      confirmed = false
      awaited = undefined
      awaitingWrite = false
      offReason = reason
    },
    onModeChange(mode) {
      const next = servedModeOf(mode)
      if (next !== undefined && (!model || next === builtMode)) {
        // Back in a served mode with the complete edit DOM: the first post asks for the host bytes, and
        // the matched `rebind` builds the model (3.6). A model of this mode, or none ever built, does nothing.
        if (!model && offReason === 'mode' && domComplete) modeReentry = true
        return
      }
      // 036 core C5 (R35.3): a mode switch releases a composition's queue first.
      if (composition) releaseComposition(composition.gen, 'mode')
      wakeSaves()
      // 036 core C2 (R3.3): a user switch: the outstanding user edits go out first, while `host` and the
      // publisher are live. After the `setEditMode` hook (R4.3) there is nothing left to post.
      flushUserEdits()
      // Task 733 / 015 (D-5): read before the teardown (R-1).
      const kept = keptAcrossSwitch(next)
      invalidateCaptures()
      modeReentry = false
      host = undefined
      cancelBuild()
      teardown('user')
      confirmed = false
      awaited = undefined
      awaitingWrite = false
      offReason = 'mode'
      if (kept) {
        buildKept(kept)
        return
      }
      // Task 733 / 013: a switch between the served modes (IR to WYSIWYG) re-enters at once.
      if (next !== undefined && domComplete) modeReentry = true
    },
    onEditDomComplete() {
      domComplete = true
      if (host) attempt()
    },
    beforeWholeTextPost(sequence, options) {
      if (!live() || !model) return reentryPost(sequence, options)
      if (!servesBuiltMode()) {
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
    holdHistoryTransition(kind, publish) {
      if (!awaitingNow() || keptBeforePost === undefined || held) {
        if (held) countHeldRefusal()
        return false
      }
      held = { kind, publish }
      return true
    },
    // Step C (2.6): while the logical publisher is live, typing is published through it, not held.
    publicationHeld: (whole) =>
      held !== undefined ||
      // Task 733 / 036 (E): nothing is published while the host text of a recovery renders.
      recovery !== undefined ||
      (exactPending !== undefined &&
        (replayLogical === undefined || replaySync === undefined)) ||
      // H2 fix design rev2 (D6.1, review point 4): an abandoned replay without its logical text (a mismatch or
      // an untranslatable input ended it) publishes nothing until the resync.
      (abandonedReplay !== undefined && replayLogical === undefined) ||
      // D6.3: no whole-text post while a replay is live, abandoned or recovering.
      (whole === true &&
        (replayLogical !== undefined || abandonedReplay !== undefined)),
    onReplayAck(message, targetOf) {
      pruneRecoveryJournal(message.epoch, message.replayOp)
      const answered = answerReplay(message.epoch, message.replayOp, targetOf)
      maybeEndLogical()
      return answered
    },
    onReplayStatus(message, targetOf) {
      const replay = exactReplay
      if (!replay && answerAbandonedStatus(message)) return false
      if (!replay || message.epoch !== replay.epoch) return false
      if (message.state === 'applied') {
        pruneRecoveryJournal(message.epoch, message.applied)
        return answerReplay(message.epoch, message.applied, targetOf)
      }
      // A refused or ended operation with no newer `update` yet: the host state replaces it (3.5).
      if (message.state === 'refused' || message.state === 'ended')
        deps.postReplay?.({
          command: 'host-state-query',
          requestId: `replay-${replay.epoch}-${replay.replayOp}`,
        })
      return false
    },
    awaitExactHistory(sequence, replay) {
      dom?.drain()
      preTouchFallback = false
      if (model && live()) model.markPublishedWhole()
      publicationBase(sequence)
      stale = true
      exactPending = sequence
      exactReply = undefined
      exactAbandoned = false
      abandonedReplay = undefined
      exactAbortSlices = false
      exactReplay = replay
      // 036 core C6 (R2.4): the replay's own sequence and epoch; a plain exact post owns nothing.
      replayOwnership = replay ? { sequence, epoch: replay.epoch } : undefined
      clearExactWatchdog()
      // B0 (3.7): with a replay operation the watchdog posts `replay-query` every 5 s (a slow host is no
      // failure). Without one, the 5 s watchdog abandons the sequence. On the window's own timers.
      if (replay) armReplayQuery()
      else
        exactWatchdog = deps.win.setTimeout(
          () => abandonExact(sequence),
          EXACT_WATCHDOG_MS,
        )
    },
    exactBusy: () =>
      exactPending !== undefined ||
      exactSlicing > 0 ||
      exactAbandoned ||
      recovery !== undefined ||
      // 036 core (R3.5): an end-to-end flag forces the busy state after the replay ended; e2e only.
      (deps.e2e === true &&
        (win as unknown as { __vmdeE2EForceBusy?: boolean })
          .__vmdeE2EForceBusy === true),
    noteInput() {
      inputSeen = true
      inputAt = deps.now()
    },
    bindReplaySync(sync) {
      replaySync = sync
    },
    replayLive: () => replayLogical !== undefined,
    flushUserEdits,
    replayLogicalText() {
      const logical = replayLogical
      const current = model
      if (!logical || !current || !live() || builtMode !== 'ir')
        return undefined
      const { state } = logical
      return state.logicalSlice(current.text, 0, state.logicalLength())
    },
    editsRefused: () =>
      abandonedReplay !== undefined && replayLogical === undefined,
    flushAbandonedInput(epoch) {
      if (!replayLogical || !exactAbandoned || epoch === undefined) return
      if (host && epoch <= host.epoch) return
      absorbReplay(postLogicalDelta)
    },
    beforeReplayInput,
    replayAcceptsInput,
    refuseReplayInput,
    deferUpdateForComposition,
    ownsHostForSave,
    saveBlocked,
    saveProofMark: () => saveMark,
    countSaveUnproven() {
      replayCounts.saveUnproven++
    },
    onSaveWake(listener) {
      saveWakeListeners.add(listener)
      return () => {
        saveWakeListeners.delete(listener)
      }
    },
    renderReplayCaretGroup,
    absorbReplayInput() {
      absorbReplay(postLogicalDelta)
    },
    drainReplayInput() {
      if (!replayLogical) return
      dom?.drain()
      absorbReplay(postLogicalDelta)
    },
    refuseReplayReentry() {
      replayCounts.replayMoveReentry++
    },
    publishReplayHistory,
    replayTableSource,
    recoverReplay,
    onHistoryTransition() {
      if (!live() || !model || !servesBuiltMode()) return
      dom?.drain()
      stale = true
      confirmed = false
      prediction = undefined
    },
    confirmedUnits() {
      if (
        !model ||
        !serving() ||
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
    historyPort: () => {
      if (builtMode === 'sv') return sourceCapture.port
      if (!exactCapturePort) exactCapturePort = slicedPort(capture.port)
      return exactCapturePort
    },
    canPublishDelta: () => live() && servesBuiltMode(),
    ownsText: () =>
      live() && servesBuiltMode() && !awaitingNow() && !stale && confirmed,
    liveMode: () => (live() ? builtMode : undefined),
    modeSwitchText: () => ownedText(),
    onWholeTextPublished(sequence, options) {
      if (!live()) return
      if (options?.requestId !== undefined)
        exactSequences.set(options.requestId, sequence)
      publicationBase(sequence)
    },
    recordFallback: countFallback,
    isLive: () => serving(),
    liveUnits() {
      if (!model || !serving()) return undefined
      const root = modelRoot()
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
    definitionContextFor(source) {
      return model && live() ? definitionIndex?.contextFor(source) : undefined
    },
    footnoteOf(label) {
      return model && live() ? definitionIndex?.footnoteOf(label) : undefined
    },
    liveUnitOf(node) {
      if (!model || !serving()) return undefined
      const root = modelRoot()
      const unit = liveUnitFor(model, root, node)
      if (unit || builtMode !== 'ir' || !DEFINITION_UNITS) return unit
      return unmappedDefinitionOf(model, root, node)
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
      // 036 core C5 (R35.3): a composition's queued updates are delivered before the session goes away.
      if (composition) releaseComposition(composition.gen, 'dispose')
      composition = undefined
      removeCompositionListeners?.()
      saveWakeListeners.clear()
      // 036 core C2 (R2.3): a user-side teardown; it publishes the outstanding user edits first.
      flushUserEdits()
      invalidateCaptures()
      cancelBuild()
      teardown('user')
      listeners.clear()
      if (deps.e2e) {
        delete (win as unknown as Record<string, unknown>)
          .__vmdeModelShadowStats
        delete (win as unknown as Record<string, unknown>)
          .__vmdeModelShadowAudit
        delete (win as unknown as Record<string, unknown>).__vmdeModelTextDigest
        if (publicationTraceContext() === traceContextReader)
          setPublicationTraceContext(undefined)
      }
    },
  }
  return session
}
