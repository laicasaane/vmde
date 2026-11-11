import type { TextModel, Unit, UnitKind } from './text-model'
import { isViewOnlyChild } from './unit-dom'

// Task 733: when the units get proven (idle slices and before a touch) and the rotating audit of
// proven units. The model and every browser service are injected, so a test drives a fake clock and
// fake animation frames. Proof is the only Lute work this module starts; it runs in a slice or in a
// pre-touch, never per mutation record (shared rules 3.3, PD-7).

type U = Unit<HTMLElement>

/** Paint frames to wait after the first start, so the proofs never delay the first paint. */
const PAINT_FRAMES = 4
/** Time a frame may spend on proofs (and then audits) before it yields; one proof may overrun it. */
const SLICE_MS = 4
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
  requestAnimationFrame(callback: () => void): number
  cancelAnimationFrame(handle: number): void
  now(): number
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
  /** Start after a build: rebuilds the proof queue now. */
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

/** Prove one queued unit if it still needs it; false when the proof could not run (Lute not ready). */
function proveIfDue(
  model: Pick<TextModel<HTMLElement>, 'prove'>,
  unit: U,
): boolean {
  if (unit.proof !== 'none' || unit.dirty) return true
  return model.prove(unit) !== 'none'
}

/** The proof queue in proof order (viewport first, then document order) and the oversize units. */
function splitProofQueues(deps: UnitScheduleDeps): { queue: U[]; large: U[] } {
  const visible: U[] = []
  const rest: U[] = []
  const large: U[] = []
  // Walk first without touching the DOM; the viewport and the HTML length are asked only for a
  // top-level unit that still has something to prove.
  const pending = (unit: U, out: U[]): void => {
    if (unit.proof === 'none' && !unit.dirty) out.push(unit)
    for (const child of unit.children) pending(child, out)
  }
  const found: U[] = []
  for (const top of deps.model.units) {
    found.length = 0
    pending(top, found)
    if (found.length === 0) continue
    const inView = deps.inViewport(top)
    for (const unit of found) {
      if (isBlockKind(unit.kind) && deps.htmlLength(unit) > OVERSIZE_HTML)
        large.push(unit)
      else (inView ? visible : rest).push(unit)
    }
  }
  return { queue: visible.concat(rest), large }
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
  let started = false
  let blocked = false
  let rebuildPending = false
  let paintFrames = PAINT_FRAMES
  let frame: number | undefined
  let idleTimer: number | undefined
  let queue: U[] = []
  let cursor = 0
  let large: U[] = []
  let largeCursor = 0
  let auditPending = false
  let auditList: U[] | undefined
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

  const buildQueues = (): void => {
    const built = splitProofQueues(deps)
    queue = built.queue
    large = built.large
    cursor = 0
    largeCursor = 0
  }

  const hasWork = (): boolean =>
    cursor < queue.length || largeCursor < large.length || auditPending

  const scheduleFrame = (): void => {
    if (started && !blocked && frame === undefined)
      frame = deps.requestAnimationFrame(onFrame)
  }

  /** The top-level unit of each audited unit, so a detached cell marks its table. */
  const auditTop = new WeakMap<U, U>()

  const collectAudit = (): U[] => {
    const list: U[] = []
    const step = (unit: U, top: U): void => {
      if (unit.kind !== 'row' && unit.canon !== undefined) {
        list.push(unit)
        auditTop.set(unit, top)
      }
      for (const child of unit.children) step(child, top)
    }
    for (const unit of model.units) step(unit, unit)
    return list
  }

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
  const runStructureAudit = (deadline: number): boolean => {
    const units = model.units
    let missed = false
    while (!missed && structUnit < units.length && deps.now() < deadline)
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

  /** Audits units until `deadline`; true when the pass is complete. */
  const runAudit = (deadline: number): boolean => {
    if (auditList === undefined) {
      auditList = collectAudit()
      resetStructureWalk()
    }
    while (auditCursor < auditList.length && deps.now() < deadline)
      audit(auditList[auditCursor++])
    if (auditCursor < auditList.length) return false
    if (!runStructureAudit(deadline)) return false
    auditList = undefined
    auditCursor = 0
    auditPending = false
    auditPasses += 1
    return true
  }

  /** Proves queued units until the slice is spent; false when a proof could not run (Lute not ready). */
  const runProofs = (deadline: number): boolean => {
    while (cursor < queue.length && deps.now() < deadline) {
      if (!proveIfDue(model, queue[cursor++])) return false
    }
    // Oversize units follow all others, at most one per frame.
    const othersDone = cursor >= queue.length
    if (othersDone && largeCursor < large.length && deps.now() < deadline)
      return proveIfDue(model, large[largeCursor++])
    return true
  }

  function onFrame(): void {
    frame = undefined
    // The mode left IR or the model went off: the loop ends; restart() or start() resumes it.
    if (!started || blocked || !deps.isActive()) return
    if (paintFrames > 0) {
      paintFrames -= 1
      scheduleFrame()
      return
    }
    if (rebuildPending) {
      rebuildPending = false
      buildQueues()
    }
    const deadline = deps.now() + SLICE_MS
    if (!runProofs(deadline)) {
      // Proofs need Lute: stop instead of spinning; start() retries.
      blocked = true
      return
    }
    if (auditPending && cursor >= queue.length && largeCursor >= large.length)
      runAudit(deadline)
    if (hasWork()) scheduleFrame()
  }

  const requestAudit = (full: boolean): void => {
    resetStructureWalk()
    if (full) {
      auditList = undefined
      auditCursor = 0
      runAudit(Number.POSITIVE_INFINITY)
      return
    }
    auditPending = true
    scheduleFrame()
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
      rebuildPending = false
      resetStructureWalk()
      buildQueues()
      scheduleFrame()
      if (idleTimer === undefined) armIdleAudit()
    },
    restart() {
      if (!started) return
      blocked = false
      rebuildPending = true
      resetStructureWalk()
      scheduleFrame()
    },
    lastFallbackReason: () => lastFallbackReason,
    stop() {
      started = false
      paintFrames = PAINT_FRAMES
      if (frame !== undefined) deps.cancelAnimationFrame(frame)
      frame = undefined
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
      for (const unit of todo)
        if (model.prove(unit) === 'none') return fallback('unproven-selection')
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
