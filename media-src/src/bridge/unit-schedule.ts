import {
  type BackgroundJob,
  type BackgroundScheduler,
  backgroundSchedulerOf,
  type SliceBudget,
} from '../util/background-budget'
import type { TextModel, Unit, UnitKind } from './text-model'
import { isViewOnlyChild } from './unit-dom'

// Task 733: when the units get proven (idle slices and before a touch) and the rotating audit of
// proven units. The model and every browser service are injected, so a test drives a fake clock and
// fake animation frames. Proof is the only Lute work this module starts; it runs in a slice or in a
// pre-touch, never per mutation record (shared rules 3.3, PD-7). Since 012-20 the queue rebuild,
// the proofs and the audit run as the frame jobs `proof-queue`, `unit-proof` and `unit-audit` of the
// shared background budget (shared rules 3.10), so their slices share one budget per frame.

type U = Unit<HTMLElement>

/** Paint frames to wait after the first start, so the proofs never delay the first paint. */
const PAINT_FRAMES = 4
/** Most unproven units a pre-touch proof handles synchronously (shared rules 3.3). */
const PRE_TOUCH_LIMIT = 32
/** A unit with HTML longer than this is proven only in idle time (shared rules 3.3). */
const OVERSIZE_HTML = 20000
/** Quiet time after the last input before an audit pass starts (PD-7). */
const IDLE_AUDIT_MS = 60_000

export interface UnitScheduleDeps {
  model: Pick<
    TextModel<HTMLElement>,
    'units' | 'unitOf' | 'prove' | 'markDirty' | 'markStructureDirty'
  >
  /** The IR root: pre-touch ranges are resolved to top-level blocks below it. */
  root: HTMLElement
  /** Canon of a unit on the live Lute (the host's `serialize`). */
  serialize(kind: UnitKind, members: readonly HTMLElement[]): string
  /** Length of a unit's HTML for the oversize bound; called only for block units, before any proof. */
  htmlLength(unit: U): number
  /** Called inside a frame, only for a unit that has something to prove. */
  inViewport(unit: U): boolean
  /** False when the mode is not IR or the model is not live: the frame loop then stops. */
  isActive(): boolean
  /** Processes the queued mutation records, so a pre-touch never proves a unit that is already dirty. */
  drain(): void
  /** The shared background scheduler; default: the one of the root's window (012-20). */
  scheduler?: BackgroundScheduler
  /** Unused since 012-20 (the scheduler owns the frames); kept so existing callers still type-check. */
  requestAnimationFrame?(callback: () => void): number
  /** Unused since 012-20, as `requestAnimationFrame`. */
  cancelAnimationFrame?(handle: number): void
  /** Unused since 012-20: slices read the scheduler's budget. */
  now?(): number
  setTimeout(callback: () => void, ms: number): number
  clearTimeout(handle: number): void
}

type ScheduleFallbackReason = 'unproven-selection' | 'oversize-unit'

interface ScheduleStats {
  /** Nodes of the unit tree: units, rows and cells (the tree the idle loop walks). */
  units: number
  proven: number
  opaque: number
  none: number
  auditMismatch: number
  auditMismatchByKind: Partial<Record<UnitKind, number>>
  auditPasses: number
}

export interface UnitSchedule {
  /** Start after a build: the proof queue is rebuilt in slices after the paint frames. */
  start(): void
  /**
   * After a publication, a rebind or a structural change: the queue is rebuilt inside the next frame,
   * so the publication path pays nothing and the viewport is tested only for blocks left to prove.
   */
  restart(): void
  stop(): void
  /** Proves every unproven unit the range touches, or answers `'fallback'` (reason in `lastFallbackReason()`). */
  proveForSelection(range: Range): 'proven' | 'fallback'
  /** Why the latest `'fallback'` answer was given; not part of `stats()`, which walks the tree. */
  lastFallbackReason(): ScheduleFallbackReason | undefined
  /** `true`: one full audit pass now. `false`: queue one pass for the idle slices. */
  requestAudit(full: boolean): void
  stats(): ScheduleStats
}

const isList = (element: Element): boolean =>
  element.tagName === 'UL' || element.tagName === 'OL'

const isBlockKind = (kind: UnitKind): boolean =>
  kind !== 'cell' && kind !== 'row' && kind !== 'table'

/** Pre-touch deadline check of a table: it is always spent, so a table proof never runs its rows there. */
const ALWAYS_SPENT = (): boolean => true

/**
 * Prove one queued unit if it still needs it. `'none'`: the proof could not run (Lute not ready);
 * `'pending'`: `spent` cut a table proof off, and the unit stays at the head of its queue.
 */
function proveIfDue(
  model: Pick<TextModel<HTMLElement>, 'prove'>,
  unit: U,
  spent: () => boolean,
): 'done' | 'none' | 'pending' {
  if (unit.proof !== 'none' || unit.dirty) return 'done'
  const result = model.prove(unit, spent)
  return result === 'none' || result === 'pending' ? result : 'done'
}

/** A pass budget that is never spent: the full audit pass and the pre-touch proof outside a slice. */
const NEVER_SPENT: SliceBudget = { spent: () => false }

/**
 * A resumable depth-first walk of the unit tree (Task 733 / 012-20, shared rules 3.10 rule 2): `step`
 * visits units until the budget is spent and keeps its place, so a whole-tree pass (the proof queue
 * rebuild, the audit collection) runs in slices. Created once per schedule; its stack is reused.
 */
interface UnitWalk {
  /** The next `step` starts a new pass from the first unit. */
  reset(): void
  /** Visits units until `budget.spent()`; true when the pass is complete. */
  step(budget: SliceBudget): boolean
}

function createUnitWalk(
  units: () => readonly U[],
  visit: (unit: U, top: U) => void,
  topDone: (top: U) => void,
): UnitWalk {
  let source: readonly U[] | undefined
  let topIndex = 0
  let topStarted = false
  let depth = 0
  const stackKids: (readonly U[])[] = []
  const stackPos: number[] = []
  const enter = (unit: U, top: U): void => {
    visit(unit, top)
    const kids = unit.children
    if (kids.length === 0) return
    stackKids[depth] = kids
    stackPos[depth] = 0
    depth += 1
  }
  /** Visits the next unit of `top`'s subtree, unless the budget is spent or the subtree is done. */
  const advance = (
    top: U,
    budget: SliceBudget,
  ): 'spent' | 'visited' | 'done' => {
    if (!topStarted) {
      if (budget.spent()) return 'spent'
      enter(top, top)
      topStarted = true
      return 'visited'
    }
    while (depth > 0) {
      const level = depth - 1
      const kids = stackKids[level]
      if (stackPos[level] < kids.length) {
        if (budget.spent()) return 'spent'
        enter(kids[stackPos[level]++], top)
        return 'visited'
      }
      depth = level
    }
    return 'done'
  }
  return {
    reset() {
      source = undefined
    },
    step(budget) {
      const current = units()
      // A new pass, or the model replaced its unit list since the last slice (R-1): start again.
      if (source !== current) {
        source = current
        topIndex = 0
        topStarted = false
        depth = 0
      }
      while (topIndex < current.length) {
        const top = current[topIndex]
        const outcome = advance(top, budget)
        if (outcome === 'spent') return false
        if (outcome === 'done') {
          topDone(top)
          topIndex += 1
          topStarted = false
        }
      }
      source = undefined
      return true
    },
  }
}

/** Why a pre-touch proof must not run for these unproven units, if it must not. */
function preTouchRefusal(
  todo: readonly U[],
  htmlLength: (unit: U) => number,
): ScheduleFallbackReason | undefined {
  // The count comes first: it costs nothing, while the oversize test reads each unit's HTML.
  if (todo.length > PRE_TOUCH_LIMIT || todo.some((u) => u.dirty))
    return 'unproven-selection'
  if (todo.some((u) => isBlockKind(u.kind) && htmlLength(u) > OVERSIZE_HTML))
    return 'oversize-unit'
  return undefined
}

/** The cells (or span-less rows) of a table unit that the range touches. */
function addTableUnits(unit: U, range: Range, out: Set<U>): void {
  for (const row of unit.children) {
    if (row.children.length === 0) {
      if (row.members.some((member) => range.intersectsNode(member)))
        out.add(row)
      continue
    }
    for (const cell of row.children)
      if (cell.el && range.intersectsNode(cell.el)) out.add(cell)
  }
}

/** The units of a top-level block that the range touches: its items, or itself and its touched cells. */
function addBlockUnits(
  model: Pick<TextModel<HTMLElement>, 'unitOf'>,
  block: HTMLElement,
  range: Range,
  out: Set<U>,
): void {
  if (isList(block)) {
    for (const item of Array.from(block.children)) {
      const unit = range.intersectsNode(item)
        ? model.unitOf(item as HTMLElement)
        : undefined
      if (unit) out.add(unit)
    }
    return
  }
  const unit = model.unitOf(block)
  if (!unit) return
  out.add(unit)
  addTableUnits(unit, range, out)
}

export function createUnitSchedule(deps: UnitScheduleDeps): UnitSchedule {
  const { model, root } = deps
  const scheduler =
    deps.scheduler ??
    backgroundSchedulerOf(root.ownerDocument.defaultView ?? window)
  let started = false
  let blocked = false
  let rebuildPending = false
  let paintFrames = PAINT_FRAMES
  let idleTimer: number | undefined
  // The proof queue in proof order: the units of top-level blocks in the viewport, then the rest in
  // document order, then the oversize units. Each list has a build twin that the sliced rebuild
  // fills; a finished rebuild swaps the pairs, so no list is copied or allocated per pass.
  let visible: U[] = []
  let rest: U[] = []
  let large: U[] = []
  let buildVisible: U[] = []
  let buildRest: U[] = []
  let buildLarge: U[] = []
  const found: U[] = []
  let cursor = 0
  let largeCursor = 0
  let auditPending = false
  // The audit pass: its unit list (collected in slices), whether the list is complete, the cursor.
  const auditList: U[] = []
  let auditCollected = false
  let auditCursor = 0
  let auditPasses = 0
  let auditMismatch = 0
  // The structure walk of a pass: units seen, root children matched, the last top-level block seen.
  let structUnit = 0
  let structChild = 0
  let structPrev: Element | undefined
  const auditMismatchByKind: Partial<Record<UnitKind, number>> = {}
  let lastFallbackReason: ScheduleFallbackReason | undefined

  const walk = (visit: (unit: U) => void): void => {
    const step = (unit: U): void => {
      visit(unit)
      for (const child of unit.children) step(child)
    }
    for (const unit of model.units) step(unit)
  }

  const unitsOf = (): readonly U[] => model.units

  // Rebuild walk: collect without touching the DOM; the viewport and the HTML length are asked only
  // for a top-level unit that still has something to prove.
  const rebuildWalk = createUnitWalk(
    unitsOf,
    (unit) => {
      if (unit.proof === 'none' && !unit.dirty) found.push(unit)
    },
    (top) => {
      if (found.length === 0) return
      const inView = deps.inViewport(top)
      for (const unit of found) {
        if (isBlockKind(unit.kind) && deps.htmlLength(unit) > OVERSIZE_HTML)
          buildLarge.push(unit)
        else (inView ? buildVisible : buildRest).push(unit)
      }
      found.length = 0
    },
  )

  const beginRebuild = (): void => {
    rebuildPending = true
    rebuildWalk.reset()
    found.length = 0
    buildVisible.length = 0
    buildRest.length = 0
    buildLarge.length = 0
  }

  const finishRebuild = (): void => {
    let swap = visible
    visible = buildVisible
    buildVisible = swap
    swap = rest
    rest = buildRest
    buildRest = swap
    swap = large
    large = buildLarge
    buildLarge = swap
    cursor = 0
    largeCursor = 0
    rebuildPending = false
  }

  const queued = (): number => visible.length + rest.length
  const queuedAt = (index: number): U =>
    index < visible.length ? visible[index] : rest[index - visible.length]

  const proofsDone = (): boolean =>
    !rebuildPending && cursor >= queued() && largeCursor >= large.length

  /** The top-level unit of each audited unit, so a detached cell marks its table. */
  const auditTop = new WeakMap<U, U>()

  const auditWalk = createUnitWalk(
    unitsOf,
    (unit, top) => {
      if (unit.kind !== 'row' && unit.canon !== undefined) {
        auditList.push(unit)
        auditTop.set(unit, top)
      }
    },
    () => undefined,
  )

  const countMismatch = (kind: UnitKind): void => {
    auditMismatch += 1
    auditMismatchByKind[kind] = (auditMismatchByKind[kind] ?? 0) + 1
  }

  /** A missed removal, insertion or move: the structure is dirty, and the next sync reads it. */
  const flagStructure = (kind: UnitKind, scope: 'root' | U = 'root'): void => {
    model.markStructureDirty(scope)
    countMismatch(kind)
  }

  const resetStructureWalk = (): void => {
    structUnit = 0
    structChild = 0
    structPrev = undefined
  }

  /** Moves past root children that never reach the Markdown (rule 3.1). */
  const skipViewOnly = (): void => {
    for (;;) {
      const child = root.children[structChild]
      if (!(child instanceof HTMLElement) || !isViewOnlyChild(child)) return
      structChild += 1
    }
  }

  /** The child of the root that holds `el`, or undefined when `el` is not below the root. */
  const rootChildOf = (el: Element): Element | undefined => {
    let node: Element | null = el
    while (node && node.parentElement !== root) node = node.parentElement
    return node ?? undefined
  }

  /** Takes the next expected root child when it holds `member`; false on a miss. */
  const takeRootChild = (member: HTMLElement): boolean => {
    const top = rootChildOf(member)
    if (top === structPrev) return true
    skipViewOnly()
    if (top === undefined || root.children[structChild] !== top) return false
    structPrev = top
    structChild += 1
    return true
  }

  /** Checks every member of a unit against the next expected root children; false on a miss. */
  const matchRootChild = (unit: U): boolean => {
    const members = unit.members.length > 0 ? unit.members : [unit.el]
    for (const member of members) {
      if (member === undefined || takeRootChild(member)) continue
      // A dirty unit's change is already queued for the next sync; only a clean one is a miss.
      if (!unit.dirty) flagStructure(unit.kind)
      return false
    }
    return true
  }

  /**
   * Top-level blocks in unit order must be the root's children in order, with none left over
   * (O(units), sliced). Returns true when the walk of this pass is complete.
   */
  const runStructureAudit = (budget: SliceBudget): boolean => {
    const units = model.units
    let missed = false
    while (!missed && structUnit < units.length && !budget.spent())
      missed = !matchRootChild(units[structUnit++])
    if (!missed && structUnit < units.length) return false
    if (!missed && units.length > 0) {
      skipViewOnly()
      if (structChild < root.children.length)
        flagStructure(units[units.length - 1].kind)
    }
    resetStructureWalk()
    return true
  }

  const audit = (unit: U): void => {
    if (!unit.dirty && unit.el !== undefined && !unit.el.isConnected) {
      const top = auditTop.get(unit)
      flagStructure(
        unit.kind,
        unit.kind === 'cell' && top?.kind === 'table' ? top : 'root',
      )
      return
    }
    if (unit.proof !== 'proven' || unit.dirty || unit.canon === undefined)
      return
    if (unit.el === undefined || unit.members.length === 0) return
    if (deps.serialize(unit.kind, unit.members) === unit.canon) return
    // Kinds and counts only (SR-5): the difference itself is never recorded.
    model.markDirty(unit)
    countMismatch(unit.kind)
  }

  /** Drops a half-collected audit pass: the next `runAudit` collects the units again. */
  const resetAuditPass = (): void => {
    auditList.length = 0
    auditCollected = false
    auditCursor = 0
    auditWalk.reset()
  }

  /** Audits units until the budget is spent; true when the pass is complete. */
  const runAudit = (budget: SliceBudget): boolean => {
    if (!auditCollected) {
      if (!auditWalk.step(budget)) return false
      auditCollected = true
    }
    while (auditCursor < auditList.length && !budget.spent())
      audit(auditList[auditCursor++])
    if (auditCursor < auditList.length) return false
    if (!runStructureAudit(budget)) return false
    resetAuditPass()
    auditPending = false
    auditPasses += 1
    return true
  }

  // The budget of the running slice, read by one check bound once per schedule: a table proof
  // checks it between rows without a closure per call (012-10, Q-105).
  let sliceBudget: SliceBudget = NEVER_SPENT
  const sliceSpent = (): boolean => sliceBudget.spent()

  /** Proves queued units until the slice is spent; true when work is left. */
  const runProofs = (budget: SliceBudget): boolean => {
    while (cursor < queued() && !budget.spent()) {
      const result = proveIfDue(model, queuedAt(cursor), sliceSpent)
      // A table cut off by the deadline is offered first in the next slice.
      if (result === 'pending') return true
      cursor += 1
      if (result === 'none') {
        // Proofs need Lute: stop instead of spinning; start() retries.
        blocked = true
        return false
      }
    }
    if (cursor < queued()) return true
    return proveLarge(budget)
  }

  /** Oversize units follow all others, at most one per slice; true when work is left. */
  const proveLarge = (budget: SliceBudget): boolean => {
    if (largeCursor < large.length && !budget.spent()) {
      const result = proveIfDue(model, large[largeCursor], sliceSpent)
      if (result === 'none') {
        blocked = true
        return false
      }
      if (result !== 'pending') largeCursor += 1
    }
    return largeCursor < large.length
  }

  // The mode left IR or the model went off: every job ends; restart() or start() resumes them.
  const runnable = (): boolean => started && !blocked && deps.isActive()

  /** Job `proof-queue`: waits out the paint frames, then rebuilds the proof queue in slices. */
  const queueJob: BackgroundJob = {
    name: 'proof-queue',
    lane: 'frame',
    step(budget) {
      if (!runnable()) return false
      if (paintFrames > 0) {
        paintFrames -= 1
        return true
      }
      if (!rebuildPending) return false
      if (!rebuildWalk.step(budget)) return true
      finishRebuild()
      return false
    },
  }

  /** Job `unit-proof`: proves the queue in slices once the queue is built. */
  const proofJob: BackgroundJob = {
    name: 'unit-proof',
    lane: 'frame',
    step(budget) {
      if (!runnable()) return false
      if (paintFrames > 0 || rebuildPending) return true
      sliceBudget = budget
      try {
        return runProofs(budget)
      } finally {
        sliceBudget = NEVER_SPENT
      }
    },
  }

  /** Job `unit-audit`: a queued audit pass, in slices after the proofs are done. */
  const auditJob: BackgroundJob = {
    name: 'unit-audit',
    lane: 'frame',
    step(budget) {
      if (!runnable() || !auditPending) return false
      if (!proofsDone()) return true
      return !runAudit(budget)
    },
  }

  const postJobs = (): void => {
    scheduler.post(queueJob)
    scheduler.post(proofJob)
    if (auditPending) scheduler.post(auditJob)
  }

  const requestAudit = (full: boolean): void => {
    resetStructureWalk()
    if (full) {
      resetAuditPass()
      runAudit(NEVER_SPENT)
      return
    }
    auditPending = true
    if (started && !blocked) scheduler.post(auditJob)
  }

  /** One audit pass per minute without input: input re-arms the timer, a firing re-arms it too. */
  const armIdleAudit = (): void => {
    if (!started) return
    if (idleTimer !== undefined) deps.clearTimeout(idleTimer)
    idleTimer = deps.setTimeout(() => {
      idleTimer = undefined
      requestAudit(false)
      armIdleAudit()
    }, IDLE_AUDIT_MS)
  }
  const noteInput = armIdleAudit

  const topLevelOf = (element: Element): HTMLElement | undefined => {
    let current: Element | null = element
    while (current && current.parentElement !== root)
      current = current.parentElement
    return (current as HTMLElement | null) ?? undefined
  }

  /** The unit of a top-level block; a list block resolves to the item that holds `inner`. */
  const unitOfBlock = (block: HTMLElement, inner: Element): U | undefined => {
    if (!isList(block)) return model.unitOf(block)
    let item: Element = inner
    while (item.parentElement !== block && item.parentElement)
      item = item.parentElement
    return item === inner && inner === block
      ? undefined
      : model.unitOf(item as HTMLElement)
  }

  const unitsAtCaret = (node: Node): U[] => {
    const element = node instanceof Element ? node : node.parentElement
    if (!element || !root.contains(element)) return []
    const out: U[] = []
    const cell = element.closest('td, th')
    const cellUnit =
      cell && root.contains(cell)
        ? model.unitOf(cell as HTMLElement)
        : undefined
    if (cellUnit) out.push(cellUnit)
    const block = topLevelOf(element)
    const unit = block ? unitOfBlock(block, element) : undefined
    if (unit && unit !== cellUnit) out.push(unit)
    return out
  }

  const boundaryBlock = (
    container: Node,
    offset: number,
    isEnd: boolean,
  ): HTMLElement | undefined => {
    if (container === root) {
      const last = root.childNodes.length - 1
      const child = root.childNodes[isEnd ? Math.min(offset, last) : offset]
      return child instanceof HTMLElement ? child : undefined
    }
    const element =
      container instanceof Element ? container : container.parentElement
    return element && root.contains(element) ? topLevelOf(element) : undefined
  }

  const touchedUnits = (range: Range): Iterable<U> => {
    if (range.collapsed) return unitsAtCaret(range.startContainer)
    const first = boundaryBlock(range.startContainer, range.startOffset, false)
    if (!first) return []
    const last = boundaryBlock(range.endContainer, range.endOffset, true)
    const out = new Set<U>()
    for (
      let block: HTMLElement | null = first;
      block;
      block = block.nextElementSibling as HTMLElement | null
    ) {
      if (range.intersectsNode(block)) addBlockUnits(model, block, range, out)
      if (!last || block === last) break
    }
    return out
  }

  const fallback = (reason: ScheduleFallbackReason): 'fallback' => {
    lastFallbackReason = reason
    return 'fallback'
  }

  return {
    start() {
      started = true
      blocked = false
      resetStructureWalk()
      beginRebuild()
      postJobs()
      if (idleTimer === undefined) armIdleAudit()
    },
    restart() {
      if (!started) return
      blocked = false
      beginRebuild()
      resetStructureWalk()
      postJobs()
    },
    lastFallbackReason: () => lastFallbackReason,
    stop() {
      started = false
      paintFrames = PAINT_FRAMES
      scheduler.cancel(queueJob)
      scheduler.cancel(proofJob)
      scheduler.cancel(auditJob)
      if (idleTimer !== undefined) deps.clearTimeout(idleTimer)
      idleTimer = undefined
    },
    proveForSelection(range) {
      // Pending records first: a unit that is already dirty must not be proven from its new DOM.
      deps.drain()
      noteInput()
      const todo: U[] = []
      for (const unit of touchedUnits(range))
        if (unit.proof === 'none') todo.push(unit)
      const refusal = preTouchRefusal(todo, deps.htmlLength)
      if (refusal) return fallback(refusal)
      // A table is checked as always spent: the pre-touch proves the touched cells and rows only,
      // never every row of a partly proven table in one call; the idle slices finish the table.
      for (const unit of todo)
        if (model.prove(unit, ALWAYS_SPENT) === 'none')
          return fallback('unproven-selection')
      return 'proven'
    },
    requestAudit,
    stats() {
      let units = 0
      let proven = 0
      let opaque = 0
      walk((unit) => {
        units += 1
        if (unit.proof === 'proven') proven += 1
        else if (unit.proof === 'opaque') opaque += 1
      })
      return {
        units,
        proven,
        opaque,
        none: units - proven - opaque,
        auditMismatch,
        auditMismatchByKind: { ...auditMismatchByKind },
        auditPasses,
      }
    },
  }
}

// ---- Pre-touch listeners (action 5), installed by the model session ----

export interface PreTouchOptions {
  root: HTMLElement
  schedule: Pick<UnitSchedule, 'proveForSelection'>
  /** `composingLock` or the shared composition state: keydown and beforeinput do not prove then. */
  isComposing(): boolean
  /** Called when a proof answered `'fallback'`; the reason is in the schedule's stats. */
  onFallback(): void
}

// Keys that cannot edit: navigation, function keys, a modifier alone.
const NAVIGATION_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Escape',
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
])

function isEditingKey(event: KeyboardEvent): boolean {
  if (NAVIGATION_KEYS.has(event.key) || /^F\d{1,2}$/u.test(event.key))
    return false
  const copyOrSelectAll =
    (event.ctrlKey || event.metaKey) && /^[ca]$/iu.test(event.key)
  return !copyOrSelectAll
}

/**
 * Capture-phase `window` listeners that prove the units an edit is about to touch. Window capture
 * runs before every document and root listener of the editor, so the proof reads the DOM before any
 * of them changes it; the schedule drains the mutation queue first.
 */
export function installPreTouchListeners(options: PreTouchOptions): () => void {
  const { root, schedule, isComposing, onFallback } = options
  const doc = root.ownerDocument
  const target: EventTarget = doc.defaultView ?? window

  const selectionRange = (event: Event): Range => {
    const selection = doc.getSelection()
    if (selection && selection.rangeCount > 0) return selection.getRangeAt(0)
    // No selection yet: the event target is what the edit touches.
    const range = doc.createRange()
    range.selectNode(event.target as Node)
    return range
  }

  const prove = (...ranges: Range[]): void => {
    let fallback = false
    for (const range of ranges)
      if (schedule.proveForSelection(range) === 'fallback') fallback = true
    if (fallback) onFallback()
  }

  const inside = (event: Event): boolean =>
    event.target instanceof Node && root.contains(event.target)

  const handlers: Array<[string, (event: Event) => void]> = [
    ['beforeinput', (e) => !isComposing() && prove(selectionRange(e))],
    [
      'keydown',
      (e) =>
        !isComposing() &&
        isEditingKey(e as KeyboardEvent) &&
        prove(selectionRange(e)),
    ],
    ['compositionstart', (e) => prove(selectionRange(e))],
    ['paste', (e) => prove(selectionRange(e))],
    ['cut', (e) => prove(selectionRange(e))],
    [
      'drop',
      (e) => {
        const { clientX, clientY } = e as DragEvent
        const point = doc.caretRangeFromPoint?.(clientX, clientY)
        prove(...(point ? [selectionRange(e), point] : [selectionRange(e)]))
      },
    ],
    [
      'dragstart',
      (e) => {
        const selection = doc.getSelection()
        const range =
          selection && selection.rangeCount > 0 && !selection.isCollapsed
            ? selection.getRangeAt(0)
            : (() => {
                const dragged = doc.createRange()
                dragged.selectNode(e.target as Node)
                return dragged
              })()
        prove(range)
      },
    ],
    [
      'mousedown',
      (e) => {
        const box = e.target as Element
        if (!box.matches?.('input[type="checkbox"]')) return
        const item = box.closest('li')
        if (!item) return
        const range = doc.createRange()
        range.selectNode(item)
        prove(range)
      },
    ],
  ]

  const bound = handlers.map(([type, handler]) => {
    const listener = (event: Event): void => {
      if (inside(event)) handler(event)
    }
    target.addEventListener(type, listener, true)
    return [type, listener] as const
  })
  return () => {
    for (const [type, listener] of bound)
      target.removeEventListener(type, listener, true)
  }
}
