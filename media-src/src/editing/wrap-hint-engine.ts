/**
 * Task 640 S2b/S2c — the DOM engine that applies the wrap-hint planner (`wrap-hints.ts`) to words
 * too wide for their line: inline code first (S2b), then plain text, emphasis, link text, headings,
 * list items, quotes and the callout preview (S2c), and table cells (S2d: the cells are line boxes
 * planned against the widths Task 639 or Task 219 applied; the Task 639 min-content clones get the
 * priority-1 hints through the `setMeasureCloneHinter` seam, see `registerCloneHinter`). The engine is view-only:
 * it inserts empty `<span class="vmde-wrap-hint" data-render="1"></span>` elements (`main.css`
 * adds the zero-width break opportunity) with `splitText` + `insertBefore` only, never inside IR
 * marker spans, images, inline HTML or rendered previews, never replacing a Text node (that would
 * lose a live caret). What may carry a hint, and how a run of text is read and rewritten, is
 * `wrap-hint-runs.ts` (jsdom-tested); this file adds measuring, scheduling and observers.
 *
 * Cost model (S1 probe 4):
 *  - only top-level blocks near the viewport are looked at (an IntersectionObserver per surface,
 *    about one viewport of margin, as Task 639 does for tables);
 *  - reads start two frames after the trigger (the first geometry read after a scroll pays the
 *    layout of what just became relevant) and run as the frame job `wrap-hints` of the shared
 *    background budget (Task 733 / 012-20, shared rules 3.10), resuming in the next slice; a table
 *    collects its runs row by row under that budget (a row cursor), so no slice reads a whole long
 *    table; inline code of every pending block is planned before any other word (Owner decision 2);
 *  - a length pre-filter (1.5 em per character, or the measured advance of a monospace font)
 *    rejects nearly every word before any layout read;
 *  - plans are cached by (word, font, line width, minLastPiece); the write phase is one pass with
 *    its own budget and writes nothing when a run already carries exactly the planned hints.
 *
 * The hint writes are made invisible to the editor's observers by `util/wrap-hint-mark.ts`.
 */
import { resyncResponsiveTables } from '../chrome/responsive-tables'
import { resolveWrapHintsMinLastPiece } from '../../../src/shared/theme-registry'
import { findScroller } from '../chrome/toolbar-scroll-guard'
import {
  type BackgroundJob,
  type BackgroundScheduler,
  backgroundSchedulerOf,
  type SliceBudget,
} from '../util/background-budget'
import { isCompositionActive } from '../util/caret-gesture'
import {
  clearWrapHints,
  insertWrapHint,
  setMeasureCloneHinter,
  withoutOwnHintRecords,
  WRAP_HINT_REPLAN_EVENT,
} from '../util/wrap-hint-mark'
import {
  firstTableRow,
  hintCloneWithPriorityOne,
  inlineCodesWithin,
  LINE_CONTAINER,
  nextTableRow,
  proseParentsWithin,
  rewriteRun,
  runsOf,
  sameOffsets,
  type TextRun,
} from './wrap-hint-runs'
import {
  DEFAULT_MIN_LAST_PIECE,
  mayBeTooWide,
  planWrapBreaks,
} from './wrap-hints'

/** Time the write phase of one slice may take; the runs left over are written next frame. */
const WRITE_BUDGET_MS = 2
/** Quiet time after the last edit before the edited block gets hints again. */
const TYPING_PAUSE_MS = 600
/** Words: runs without white space or a zero-width space (WYSIWYG code starts with one). */
const WORD = /[^\s\u200B]+/gu
const ASCII_PRINTABLE = /^[\x21-\x7e]+$/u
/** Prose runs without a word this long cannot hold a hint worth the style reads. */
const LONG_WORD = /[^\s\u200B]{8}/u
const PLAN_CACHE_LIMIT = 4000

// ---------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------

/** The Range-rect width of `[from, to)` in the run's text, summed over its line fragments. */
function rangeWidth(
  range: Range,
  run: TextRun,
  from: number,
  to: number,
): number {
  const locate = (offset: number, atEnd: boolean): [Text, number] => {
    for (let i = 0; i < run.nodes.length; i += 1) {
      const start = run.starts[i]
      const end = start + run.nodes[i].length
      if (offset < end || (atEnd && offset === end))
        return [run.nodes[i], offset - start]
    }
    const last = run.nodes[run.nodes.length - 1]
    return [last, last.length]
  }
  const [startNode, startOffset] = locate(from, false)
  const [endNode, endOffset] = locate(to, true)
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  let width = 0
  for (const rect of Array.from(range.getClientRects())) width += rect.width
  return width
}

interface LineBox {
  /** Width of the line box available to the run's text, px. */
  width: number
  fontSize: number
  fontKey: string
  /** Advance of every ASCII glyph when the font is monospace, else null. */
  advance: number | null
}

let measureContext: CanvasRenderingContext2D | null | undefined
const advanceByFont = new Map<string, number | null>()

/** The shared advance of a monospace font (all of `0`, `i`, `M` equal), cached by font key. */
function monospaceAdvance(
  style: CSSStyleDeclaration,
  fontKey: string,
): number | null {
  if (advanceByFont.has(fontKey)) return advanceByFont.get(fontKey) ?? null
  let advance: number | null = null
  try {
    if (measureContext === undefined)
      measureContext = document.createElement('canvas').getContext('2d')
    if (measureContext) {
      measureContext.font = fontKey
      const widths = ['0', 'i', 'M'].map(
        (ch) => measureContext!.measureText(ch).width,
      )
      const spacing = Number.parseFloat(style.letterSpacing) || 0
      if (widths[0] > 0 && widths.every((w) => Math.abs(w - widths[0]) < 0.01))
        advance = widths[0] + spacing
    }
  } catch {
    advance = null
  }
  advanceByFont.set(fontKey, advance)
  return advance
}

const px = (value: string): number => Number.parseFloat(value) || 0

/**
 * The line box of the text children of `parent`, or null when it has no layout (hidden, detached,
 * not rendered yet). The content width of the nearest block container, minus the padding and
 * border of `parent` itself when it is an inline box (inline code) inside that container.
 */
function lineBoxOf(
  parent: Element,
  containers: Map<Element, number>,
): LineBox | null {
  const container =
    parent.closest<HTMLElement>(LINE_CONTAINER) ?? parent.parentElement
  if (!container) return null
  let containerWidth = containers.get(container)
  if (containerWidth === undefined) {
    const style = getComputedStyle(container)
    containerWidth =
      container.clientWidth - px(style.paddingLeft) - px(style.paddingRight)
    containers.set(container, containerWidth)
  }
  if (containerWidth <= 0) return null
  const style = getComputedStyle(parent)
  const fontKey = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const boxEdges =
    parent === container
      ? 0
      : px(style.paddingLeft) +
        px(style.paddingRight) +
        px(style.borderLeftWidth) +
        px(style.borderRightWidth)
  return {
    width: containerWidth - boxEdges,
    fontSize: px(style.fontSize),
    fontKey,
    advance: monospaceAdvance(style, fontKey),
  }
}

// ---------------------------------------------------------------------------------------------
// Planning one run
// ---------------------------------------------------------------------------------------------

export interface WrapHintOptions {
  /** The `minLastPiece` rule (graphemes); default 3. */
  minLastPiece?: number
  /** The shared background scheduler; default: the one of the window (Task 733 / 012-20). */
  scheduler?: BackgroundScheduler
}

interface WrapHintStats {
  runs: number
  blocks: number
  codes: number
  words: number
  preFilterPassed: number
  planned: number
  cacheHits: number
  writes: number
  hints: number
  deferred: number
  readMs: number
  writeMs: number
  maxSliceMs: number
}

type WrapHintWindow = Window & {
  __vmdeE2EReadiness?: unknown
  __vmdeWrapHintStats?: WrapHintStats
  __vmdeWrapHintsE2E?: {
    insertHint(code: Element, offset: number): void
    clearHints(code: Element): void
  }
}

/** Counters and test hooks for the Chromium specs, only when the page runs under the e2e harness. */
function e2eStats(): WrapHintStats | null {
  const win = window as WrapHintWindow
  if (!win.__vmdeE2EReadiness) return null
  win.__vmdeWrapHintStats ??= {
    runs: 0,
    blocks: 0,
    codes: 0,
    words: 0,
    preFilterPassed: 0,
    planned: 0,
    cacheHits: 0,
    writes: 0,
    hints: 0,
    deferred: 0,
    readMs: 0,
    writeMs: 0,
    maxSliceMs: 0,
  }
  win.__vmdeWrapHintsE2E = {
    insertHint: (code, offset) =>
      insertWrapHint(code.firstChild as Text, offset),
    clearHints: (code) => {
      clearWrapHints(code)
    },
  }
  return win.__vmdeWrapHintStats
}

/** The element whose scrollport clips the surface (as Task 639 resolves it for tables). */
function surfaceScroller(surface: HTMLElement): HTMLElement {
  const overflow = getComputedStyle(surface).overflowY
  return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay'
    ? surface
    : findScroller(surface)
}

/** Everything `planRunOffsets` shares across the runs of one slice. */
interface PlanContext {
  range: Range
  plans: Map<string, number[]>
  minLastPiece: number
  stats: WrapHintStats | null
}

/** Plan one word: the cached plan for (font, line width, N, word) or a fresh one from Range reads. */
function planWord(
  word: string,
  start: number,
  run: TextRun,
  box: LineBox,
  context: PlanContext,
): number[] {
  const key = `${box.fontKey}|${box.width.toFixed(2)}|${context.minLastPiece}|${word}`
  const cached = context.plans.get(key)
  if (cached) {
    if (context.stats) context.stats.cacheHits += 1
    return cached
  }
  const plan = planWrapBreaks(
    word,
    (_piece, from, to) =>
      rangeWidth(context.range, run, start + from, start + to),
    box.width,
    context.minLastPiece,
  )
  if (context.plans.size >= PLAN_CACHE_LIMIT) context.plans.clear()
  context.plans.set(key, plan)
  if (context.stats) context.stats.planned += 1
  return plan
}

/** The length pre-filter for one word: can it be wider than the line? Counts for the e2e stats. */
function mayExceedLine(
  word: string,
  box: LineBox,
  stats: WrapHintStats | null,
): boolean {
  const ascii = ASCII_PRINTABLE.test(word)
  const length = ascii ? word.length : Array.from(word).length
  const advance = ascii ? (box.advance ?? undefined) : undefined
  const passes = mayBeTooWide(length, box.width, box.fontSize, advance)
  if (stats) {
    stats.words += 1
    if (passes) stats.preFilterPassed += 1
  }
  return passes
}

/**
 * The hint offsets (in the run's text) the run should carry, or what it carries now when it has no
 * layout. Reads only: the caller writes afterwards.
 */
function planRunOffsets(
  run: TextRun,
  containers: Map<Element, number>,
  context: PlanContext,
): number[] {
  const box = lineBoxOf(run.parent, containers)
  if (!box) return run.hints
  const offsets: number[] = []
  for (const match of run.text.matchAll(WORD)) {
    const word = match[0]
    if (!mayExceedLine(word, box, context.stats)) continue
    const start = match.index ?? 0
    for (const position of planWord(word, start, run, box, context))
      offsets.push(start + position)
  }
  return offsets
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

interface SurfaceState {
  surface: HTMLElement
  intersections: IntersectionObserver
  mutations: MutationObserver
  resize: ResizeObserver | undefined
  width: number
  tracked: Set<Element>
  /** The table-width replan listener (S2d), set once the surface is added. */
  onReplan: (event: Event) => void
}

/**
 * A unit whose runs did not fit in one slice (a long table): the runs read at its first slice and
 * the index to resume at. Any change inside the unit drops it, so the cached runs are never stale.
 */
interface PartialPlan {
  runs: TextRun[]
  next: number
  deferred: boolean
  /**
   * A top-level table only (012-20): the next row whose runs are collected, `null` when every row
   * was collected. `runs` then holds the collected runs not yet planned.
   */
  row?: Element | null
}

/**
 * One planning stage of a unit. Inline code is the first stage and the other words the second
 * (Owner decision 2: code first, then the other words); a unit is pending per stage. A unit is a
 * top-level block, or one cell or row of a top-level table (an edit in a cell plans that cell only).
 */
interface Stage {
  /** Units near the viewport whose text of this stage has not been looked at since the last change. */
  pending: Set<Element>
  /** The generation a unit was last planned in; a layout change bumps the generation. */
  planned: WeakMap<Element, number>
  /** Units planned up to a run index when the frame budget ran out; resumed next slice. */
  partial: Map<Element, PartialPlan>
  runsIn(block: Element): TextRun[]
}

const newStage = (runsIn: Stage['runsIn']): Stage => ({
  pending: new Set(),
  planned: new WeakMap(),
  partial: new Map(),
  runsIn,
})

/** Remember where planning of a unit stopped; allocated only when the budget runs out inside it. */
function keepPartial(
  stage: Stage,
  unit: Element,
  partial: PartialPlan | undefined,
  runs: TextRun[],
  next: number,
  deferred: boolean,
): void {
  if (partial) {
    partial.next = next
    partial.deferred = deferred
  } else stage.partial.set(unit, { runs, next, deferred })
}

/** How planning one unit in a slice ended. */
type PlanOutcome = 'done' | 'deferred' | 'partial'

/** Prose runs that can hold a long word (or already carry a hint). */
const proseRuns = (block: Element): TextRun[] =>
  proseParentsWithin(block)
    .flatMap(runsOf)
    .filter((run) => run.hints.length > 0 || LONG_WORD.test(run.text))

/** What one slice of reads decided: runs to rewrite and how long the typing pause still lasts. */
interface SliceResult {
  writes: Array<{
    stage: Stage
    block: Element
    run: TextRun
    offsets: number[]
  }>
  blocks: number
  waitFor: number
}

class WrapHintEngine {
  private readonly surfaces = new Map<HTMLElement, SurfaceState>()
  /** Top-level blocks inside the observer margin. */
  private readonly near = new Set<Element>()
  private readonly stages: Stage[] = [
    newStage((block) => inlineCodesWithin(block).flatMap(runsOf)),
    newStage(proseRuns),
  ]
  private readonly context: PlanContext
  private generation = 0
  private lastInputAt = Number.NEGATIVE_INFINITY
  /** The job is posted and not finished; the first step after a post only waits a frame. */
  private queued = false
  private warmup = false
  private readonly scheduler: BackgroundScheduler
  private readonly job: BackgroundJob
  private retry: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private readonly unregisterCloneHinter: () => void

  constructor(
    private readonly getSurfaces: () => Array<HTMLElement | null | undefined>,
    private readonly stats: WrapHintStats | null,
    minLastPiece: number,
    scheduler: BackgroundScheduler,
  ) {
    this.scheduler = scheduler
    this.job = {
      name: 'wrap-hints',
      lane: 'frame',
      step: (budget) => this.step(budget),
    }
    this.context = {
      range: document.createRange(),
      plans: new Map(),
      minLastPiece,
      stats,
    }
    document.fonts?.addEventListener('loadingdone', this.bumpGeneration)
    // Task 639 asks for the priority-1 hints of its measurement clones through this seam (the chrome
    // layer does not import this layer).
    this.unregisterCloneHinter = setMeasureCloneHinter(
      (clone, columnWidths, floor) =>
        hintCloneWithPriorityOne(
          clone,
          columnWidths,
          floor,
          this.context.minLastPiece,
        ),
    )
    this.syncSurfaces()
    this.schedule()
  }

  /**
   * A changed `vmde.editor.wrapHints.minLastPiece`: plan every near block again (the plan-cache key
   * includes N, so stale plans are never reused). Returns whether the value changed.
   */
  setMinLastPiece(minLastPiece: number): boolean {
    if (this.context.minLastPiece === minLastPiece) return false
    this.context.minLastPiece = minLastPiece
    this.bumpGeneration()
    return true
  }

  dispose(): void {
    this.disposed = true
    this.unregisterCloneHinter()
    this.scheduler.cancel(this.job)
    this.queued = false
    if (this.retry !== undefined) clearTimeout(this.retry)
    document.fonts?.removeEventListener('loadingdone', this.bumpGeneration)
    for (const state of [...this.surfaces.values()]) this.removeSurface(state)
    this.near.clear()
    for (const stage of this.stages) {
      stage.pending.clear()
      stage.partial.clear()
    }
    this.context.plans.clear()
  }

  // Triggers ------------------------------------------------------------------------------------

  private readonly bumpGeneration = (): void => {
    this.generation += 1
    for (const stage of this.stages) {
      // A layout change moves every line box: a unit planned halfway starts again.
      stage.partial.clear()
      for (const block of this.near) stage.pending.add(block)
    }
    this.schedule()
  }

  /**
   * The applied column widths of a table changed (Task 639 recompute, Task 219 drag end, auto-fit,
   * a cleared manual width): its cells are planned again against the new line boxes.
   */
  private onReplan(state: SurfaceState, event: Event): void {
    if (!(event.target instanceof Node)) return
    this.markDirty(topLevelBlock(state.surface, event.target))
    this.schedule()
  }

  private readonly onInput = (): void => {
    this.lastInputAt = performance.now()
  }

  private schedule(): void {
    if (this.disposed || this.queued) return
    // Two frames: the first geometry read after a trigger lays out whatever just became relevant
    // (S1 probe 4); by the second frame that cost is paid and the reads are cheap.
    this.queued = true
    this.warmup = true
    this.scheduler.post(this.job)
  }

  /** One slice of the `wrap-hints` job; true when work is left for the next slice. */
  private step(budget: SliceBudget): boolean {
    let more = false
    try {
      more = this.run(budget)
    } finally {
      // A step that throws is dropped by the scheduler: the next trigger posts the job again.
      this.queued = more
    }
    return more
  }

  private onIntersections(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) this.forget(entry.target)
      else {
        this.near.add(entry.target)
        for (const stage of this.stages)
          if (stage.planned.get(entry.target) !== this.generation)
            stage.pending.add(entry.target)
      }
    }
    this.schedule()
  }

  private onMutations(state: SurfaceState, records: MutationRecord[]): void {
    const real = withoutOwnHintRecords(records)
    for (const record of real) this.onRecord(state, record)
    if (real.length > 0) this.schedule()
  }

  private onRecord(state: SurfaceState, record: MutationRecord): void {
    if (record.type === 'attributes') {
      // A class or `open` change can show text that had no layout when it was last looked at: the
      // IR callout swaps its source and preview halves on the blockquote, a `details` opens, a
      // folded section is shown again. Other elements' class changes do not move line boxes.
      const target = record.target as Element
      if (
        target.parentElement === state.surface ||
        /^(BLOCKQUOTE|DETAILS)$/.test(target.tagName)
      )
        this.markDirty(topLevelBlock(state.surface, target))
      return
    }
    if (record.type !== 'childList' || record.target !== state.surface) {
      this.markChanged(state, record)
      return
    }
    for (const node of Array.from(record.removedNodes))
      if (node instanceof Element) this.untrackBlock(state, node)
    for (const node of Array.from(record.addedNodes))
      if (node instanceof Element) this.trackBlock(state, node)
  }

  /** A text or child change inside a top-level block: mark the unit it touched. */
  private markChanged(state: SurfaceState, record: MutationRecord): void {
    if (
      record.type === 'childList' &&
      isTableFrame(state.surface, record.target)
    ) {
      // Rows or cells added to a top-level table are planned on their own; a removal plans
      // nothing (its hints leave with it; changed column widths come through the replan event).
      for (const node of Array.from(record.addedNodes))
        if (node instanceof Element) this.markDirty(node)
      return
    }
    this.markDirty(dirtyUnitOf(state.surface, record.target))
  }

  private markDirty(unit: Element | null): void {
    if (!unit) return
    const near = this.isNear(unit)
    for (const stage of this.stages) {
      // The units that contain this one (the table of an edited cell) are changed too: one planned
      // halfway holds runs read before the change and starts again, and a table outside the margin
      // is planned again when it comes back near.
      for (
        let element: Element | null = unit;
        element;
        element = element.parentElement
      ) {
        stage.partial.delete(element)
        stage.planned.delete(element)
      }
      if (near) stage.pending.add(unit)
    }
  }

  /** Is the unit a near top-level block, or inside one (a cell or row of a near table)? */
  private isNear(unit: Element): boolean {
    for (
      let element: Element | null = unit;
      element;
      element = element.parentElement
    )
      if (this.near.has(element)) return true
    return false
  }

  /** Drop a block that left the observer margin or the document. */
  private forget(block: Element): void {
    this.near.delete(block)
    for (const stage of this.stages) {
      stage.pending.delete(block)
      stage.partial.delete(block)
    }
  }

  // Surfaces ------------------------------------------------------------------------------------

  private trackBlock(state: SurfaceState, block: Element): void {
    if (state.tracked.has(block)) return
    state.tracked.add(block)
    state.intersections.observe(block)
  }

  private untrackBlock(state: SurfaceState, block: Element): void {
    if (!state.tracked.delete(block)) return
    state.intersections.unobserve(block)
    this.forget(block)
  }

  private addSurface(surface: HTMLElement): void {
    const scroller = surfaceScroller(surface)
    const isDocument =
      scroller === document.scrollingElement ||
      scroller === document.documentElement
    const state: SurfaceState = {
      surface,
      // About one viewport of margin above and below, as Task 639 uses for tables.
      intersections: new IntersectionObserver(
        (entries) => this.onIntersections(entries),
        {
          root: isDocument ? null : scroller,
          rootMargin: '100% 0px',
          threshold: 0,
        },
      ),
      mutations: new MutationObserver((records) =>
        this.onMutations(state, records),
      ),
      resize: undefined,
      width: surface.clientWidth,
      tracked: new Set(),
      onReplan: () => undefined,
    }
    state.mutations.observe(surface, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'open'],
    })
    if (typeof ResizeObserver !== 'undefined') {
      state.resize = new ResizeObserver(() => this.onSurfaceResize(state))
      state.resize.observe(surface)
    }
    // A user edit (typing, deleting, composing) starts the pause that keeps the edited block's
    // hints off until the typing stops.
    surface.addEventListener('beforeinput', this.onInput, true)
    surface.addEventListener('compositionend', this.onInput, true)
    state.onReplan = (event) => this.onReplan(state, event)
    surface.addEventListener(WRAP_HINT_REPLAN_EVENT, state.onReplan)
    this.surfaces.set(surface, state)
    for (const child of Array.from(surface.children))
      this.trackBlock(state, child)
  }

  private onSurfaceResize(state: SurfaceState): void {
    const width = state.surface.clientWidth
    if (Math.abs(width - state.width) < 1) return
    state.width = width
    this.bumpGeneration()
  }

  private removeSurface(state: SurfaceState): void {
    state.intersections.disconnect()
    state.mutations.disconnect()
    state.resize?.disconnect()
    state.surface.removeEventListener('beforeinput', this.onInput, true)
    state.surface.removeEventListener('compositionend', this.onInput, true)
    state.surface.removeEventListener(WRAP_HINT_REPLAN_EVENT, state.onReplan)
    for (const block of state.tracked) this.forget(block)
    this.surfaces.delete(state.surface)
  }

  private syncSurfaces(): void {
    const live = new Set(
      this.getSurfaces().filter((s): s is HTMLElement => Boolean(s)),
    )
    for (const state of [...this.surfaces.values()])
      if (!(live.has(state.surface) && state.surface.isConnected))
        this.removeSurface(state)
    for (const surface of live)
      if (!this.surfaces.has(surface)) this.addSurface(surface)
  }

  // Work ----------------------------------------------------------------------------------------

  /** Is the caret or selection inside `parent` while an edit is recent? */
  private holdsActiveCaret(parent: Element): boolean {
    if (performance.now() - this.lastInputAt >= TYPING_PAUSE_MS) return false
    const selection = window.getSelection()
    return Boolean(
      selection &&
        selection.rangeCount > 0 &&
        parent.contains(selection.anchorNode),
    )
  }

  /**
   * Plan the runs of one unit in one stage under the slice budget (cause C3: a long table must not
   * take every run in one slice). Returns 'partial' when the budget ran out with runs left, which
   * are resumed next slice; 'deferred' when some run waits for the typing pause.
   */
  private planBlock(
    stage: Stage,
    block: Element,
    containers: Map<Element, number>,
    result: SliceResult,
    budget: SliceBudget,
  ): PlanOutcome {
    const partial = stage.partial.get(block)
    if (block.tagName === 'TABLE')
      return this.planTable(stage, block, containers, result, budget, partial)
    const runs = partial?.runs ?? stage.runsIn(block)
    let deferred = partial?.deferred ?? false
    for (let index = partial?.next ?? 0; index < runs.length; index += 1) {
      if (this.planCached(stage, block, runs[index], containers, result))
        deferred = true
      if (index + 1 < runs.length && budget.spent()) {
        keepPartial(stage, block, partial, runs, index + 1, deferred)
        return 'partial'
      }
    }
    if (partial) stage.partial.delete(block)
    return deferred ? 'deferred' : 'done'
  }

  /**
   * A top-level table (012-20, N9): its runs are collected row by row and planned as they are
   * collected, the budget checked before each row and each run, so a slice reads only the rows
   * that fit in it. The plan (allocated once per table pass) keeps the row cursor.
   */
  private planTable(
    stage: Stage,
    table: Element,
    containers: Map<Element, number>,
    result: SliceResult,
    budget: SliceBudget,
    partial: PartialPlan | undefined,
  ): PlanOutcome {
    let plan = partial
    if (!plan) {
      plan = { runs: [], next: 0, deferred: false, row: undefined }
      stage.partial.set(table, plan)
    }
    for (;;) {
      if (plan.next < plan.runs.length) {
        const run = plan.runs[plan.next]
        plan.next += 1
        if (this.planCached(stage, table, run, containers, result))
          plan.deferred = true
      } else if (plan.row === null) break
      else this.collectRow(stage, table, plan)
      const left = plan.next < plan.runs.length || plan.row !== null
      if (left && budget.spent()) return 'partial'
    }
    stage.partial.delete(table)
    return plan.deferred ? 'deferred' : 'done'
  }

  /** Collects the runs of the plan's next row and moves the row cursor on. */
  private collectRow(stage: Stage, table: Element, plan: PartialPlan): void {
    plan.runs.length = 0
    plan.next = 0
    let row = plan.row === undefined ? firstTableRow(table) : plan.row
    // A row removed since the last slice leaves the cursor outside the table: collect from the
    // first row again (planned runs are cached, so the repeat costs no layout work).
    if (row && !(row.isConnected && row.closest('table') === table))
      row = firstTableRow(table)
    if (!row) {
      plan.row = null
      return
    }
    plan.row = nextTableRow(table, row)
    for (const run of stage.runsIn(row)) plan.runs.push(run)
  }

  /** Plan one run that may have left the document since it was collected; true when it waits. */
  private planCached(
    stage: Stage,
    block: Element,
    run: TextRun,
    containers: Map<Element, number>,
    result: SliceResult,
  ): boolean {
    // A run cached by a partial plan can have left the document with an edit outside its unit.
    return (
      run.parent.isConnected &&
      this.planRun(stage, block, run, containers, result)
    )
  }

  /** Plan one run; true when it waits for the typing pause. */
  private planRun(
    stage: Stage,
    block: Element,
    run: TextRun,
    containers: Map<Element, number>,
    result: SliceResult,
  ): boolean {
    if (this.stats) this.stats.codes += 1
    const offsets = planRunOffsets(run, containers, this.context)
    if (sameOffsets(run.hints, offsets)) return false
    if (!this.holdsActiveCaret(run.parent)) {
      result.writes.push({ stage, block, run, offsets })
      return false
    }
    // The edited text waits for the typing pause (Vditor rebuilds the block on input anyway).
    if (this.stats) this.stats.deferred += 1
    result.waitFor = Math.max(
      result.waitFor,
      TYPING_PAUSE_MS - (performance.now() - this.lastInputAt),
    )
    return true
  }

  /** Read phase: plan near, changed blocks until the slice budget is spent, code stage first. */
  private readSlice(budget: SliceBudget): SliceResult {
    const containers = new Map<Element, number>()
    const result: SliceResult = { writes: [], blocks: 0, waitFor: 0 }
    for (const stage of this.stages) {
      for (const block of [...stage.pending]) {
        if (!(block.isConnected && this.isNear(block))) {
          stage.pending.delete(block)
          stage.partial.delete(block)
          continue
        }
        const outcome = this.planBlock(stage, block, containers, result, budget)
        result.blocks += 1
        if (outcome === 'done') {
          stage.pending.delete(block)
          stage.planned.set(block, this.generation)
        }
        if (outcome === 'partial' || budget.spent()) return result
      }
    }
    return result
  }

  private hasPending(): boolean {
    return this.stages.some((stage) => stage.pending.size > 0)
  }

  /** One slice: true when blocks are left for the next slice. */
  private run(budget: SliceBudget): boolean {
    if (this.disposed) return false
    if (this.warmup) {
      this.warmup = false
      return true
    }
    if (isCompositionActive()) {
      this.retry = setTimeout(() => this.schedule(), 100)
      return false
    }
    this.syncSurfaces()
    const started = performance.now()
    const result = this.readSlice(budget)
    const readEnd = performance.now()
    // One write phase: nothing below reads layout. It stops at its own budget; the blocks of the
    // runs it did not reach are planned again next frame (their plans are cached).
    const hints = this.writeSlice(result.writes)
    this.record(started, readEnd, result, hints)
    if (result.waitFor > 0) {
      this.retry = setTimeout(() => this.schedule(), result.waitFor + 20)
      return false
    }
    return this.hasPending()
  }

  private writeSlice(writes: SliceResult['writes']): number {
    const started = performance.now()
    let hints = 0
    for (const [index, write] of writes.entries()) {
      if (index > 0 && performance.now() - started > WRITE_BUDGET_MS) {
        for (const left of writes.slice(index)) {
          left.stage.planned.delete(left.block)
          left.stage.pending.add(left.block)
          // A unit planned halfway would resume past the run not written: plan it from the start.
          left.stage.partial.delete(left.block)
        }
        break
      }
      if (rewriteRun(write.run, write.offsets)) hints += write.offsets.length
    }
    return hints
  }

  private record(
    started: number,
    readEnd: number,
    result: SliceResult,
    hints: number,
  ): void {
    if (!this.stats) return
    const done = performance.now()
    this.stats.runs += 1
    this.stats.blocks += result.blocks
    this.stats.writes += result.writes.length
    this.stats.hints += hints
    this.stats.readMs += readEnd - started
    this.stats.writeMs += done - readEnd
    this.stats.maxSliceMs = Math.max(this.stats.maxSliceMs, done - started)
  }
}

const TABLE_FRAME = /^(TABLE|THEAD|TBODY|TFOOT|TR)$/

/** The cell of a top-level `table` that holds `element` (the outer cell for a nested table). */
function cellOf(table: Element, element: Element): Element | null {
  let cell = element.closest('td, th')
  while (cell && cell.parentElement?.closest('table') !== table)
    cell = cell.parentElement?.closest('td, th') ?? null
  return cell
}

/**
 * The unit a change at `node` makes dirty: the cell of a top-level table that holds it, else the
 * top-level block (cause C3: a cell edit used to replan the whole table).
 */
function dirtyUnitOf(surface: HTMLElement, node: Node): Element | null {
  const block = topLevelBlock(surface, node)
  if (block?.tagName !== 'TABLE') return block
  const element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return (element && cellOf(block, element)) ?? block
}

/** Is `node` a row group or row of a top-level table, outside every cell? */
function isTableFrame(surface: HTMLElement, node: Node): boolean {
  if (!(node instanceof Element && TABLE_FRAME.test(node.tagName))) return false
  const block = topLevelBlock(surface, node)
  return block?.tagName === 'TABLE' && cellOf(block, node) === null
}

function topLevelBlock(surface: HTMLElement, node: Node): Element | null {
  let element: Element | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  while (element && element.parentElement !== surface)
    element = element.parentElement
  return element
}

/**
 * Install the engine. `getSurfaces` lists the editable and preview roots (IR, WYSIWYG, Preview);
 * it is read again on every run, so a surface that appears later (a mode switch) is picked up.
 * Returns the disposer.
 */
export function installWrapHints(
  getSurfaces: () => Array<HTMLElement | null | undefined>,
  options: WrapHintOptions = {},
): () => void {
  // Unit-test DOMs have neither observer nor frames: nothing to do there.
  if (
    typeof IntersectionObserver === 'undefined' ||
    typeof requestAnimationFrame === 'undefined'
  )
    return () => undefined
  const engine = new WrapHintEngine(
    getSurfaces,
    e2eStats(),
    options.minLastPiece ?? DEFAULT_MIN_LAST_PIECE,
    options.scheduler ?? backgroundSchedulerOf(window),
  )
  activeEngine = engine
  return () => {
    if (activeEngine === engine) activeEngine = undefined
    engine.dispose()
  }
}

let activeEngine: WrapHintEngine | undefined

/**
 * Task 640 S2e: apply a changed `minLastPiece` to the installed engine without re-initialising the
 * editor. Returns true when the value changed (the caller then measures automatic tables again,
 * because Task 639 min-content uses the pieces left by the final-piece rule). False when no engine
 * is installed or the value is the current one.
 */
export function setWrapHintsMinLastPiece(minLastPiece: number): boolean {
  return activeEngine?.setMinLastPiece(minLastPiece) ?? false
}

/**
 * Task 640 S2e: a changed `vmde.editor.wrapHints.minLastPiece` (the raw value of the config payload)
 * re-plans the near blocks and tables with no Vditor re-init, and measures the automatic tables
 * again, because Task 639 min-content counts the pieces the final-piece rule leaves. Runs on every
 * config change and does nothing when the value is the current one. View-only: no edit, no Undo.
 */
export function applyWrapHintsSetting(value: number | undefined): void {
  if (setWrapHintsMinLastPiece(resolveWrapHintsMinLastPiece(value)))
    resyncResponsiveTables()
}
