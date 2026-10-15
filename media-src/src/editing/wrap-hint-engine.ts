/**
 * Task 640 S2b — the DOM engine that applies the wrap-hint planner (`wrap-hints.ts`) to inline code.
 *
 * Inline code is the first target: a path or an identifier in `<code>` is the common long word,
 * and its text is plain (IR and WYSIWYG code has one Text child; Preview is plain HTML). Other
 * words (S2c) and table cells (S2d) come later. The engine is view-only: it inserts empty
 * `<span class="vmde-wrap-hint" data-render="1"></span>` elements (`main.css` adds the zero-width
 * break opportunity) with `splitText` + `insertBefore` only, never inside IR marker spans or
 * `[data-render]` previews, never replacing a Text node (that would lose a live caret).
 *
 * Cost model (S1 probe 4):
 *  - only top-level blocks near the viewport are looked at (an IntersectionObserver per surface,
 *    about one viewport of margin, as Task 639 does for tables);
 *  - reads start two frames after the trigger (the first geometry read after a scroll pays the
 *    layout of what just became relevant), run under a ~4 ms frame budget and resume next frame;
 *  - a length pre-filter (1.5 em per character, or the measured advance of a monospace font)
 *    rejects nearly every word before any layout read;
 *  - plans are cached by (word, font, line width, minLastPiece); the write phase is one pass and
 *    writes nothing when a code element already carries exactly the planned hints.
 *
 * The hint writes are made invisible to the editor's observers by `util/wrap-hint-mark.ts`.
 */
import { findScroller } from '../chrome/toolbar-scroll-guard'
import { isCompositionActive } from '../util/caret-gesture'
import {
  clearWrapHints,
  expectOwnTexts,
  insertWrapHint,
  insertWrapHintBefore,
  withoutOwnHintRecords,
  WRAP_HINT_CLASS,
} from '../util/wrap-hint-mark'
import {
  DEFAULT_MIN_LAST_PIECE,
  mayBeTooWide,
  planWrapBreaks,
} from './wrap-hints'

/** Time one slice of reads and planning may take before it yields to the next frame. */
const FRAME_BUDGET_MS = 4
/** Time the write phase of one slice may take; the codes left over are written next frame. */
const WRITE_BUDGET_MS = 2
/** Quiet time after the last edit before the edited block gets hints again. */
const TYPING_PAUSE_MS = 600
/** Words: runs without white space or a zero-width space (WYSIWYG code starts with one). */
const WORD = /[^\s\u200B]+/gu
const ASCII_PRINTABLE = /^[\x21-\x7e]+$/u
/** The nearest block whose content box is the line box of the code. */
const LINE_CONTAINER =
  'p, li, h1, h2, h3, h4, h5, h6, blockquote, summary, dd, dt'
/**
 * Code the engine must leave alone: fenced code (`pre`), tables (S2d), hidden Markdown syntax (IR
 * markers), rendered previews and widgets (`data-render`, IR/WYSIWYG preview halves) and anything
 * not editable text (`contenteditable="false"`).
 */
const EXCLUDED_ANCESTOR =
  'pre:not(.vditor-reset), table, .vditor-ir__marker, [data-render], [contenteditable="false"], .vditor-ir__preview, .vditor-wysiwyg__preview'
const PLAN_CACHE_LIMIT = 4000

// ---------------------------------------------------------------------------------------------
// Pure DOM helpers (tested in jsdom)
// ---------------------------------------------------------------------------------------------

/** Inline `<code>` elements of a block that the engine may hint, in document order. */
export function inlineCodesWithin(block: Element): HTMLElement[] {
  return Array.from(block.querySelectorAll<HTMLElement>('code')).filter(
    (code) => !code.closest(EXCLUDED_ANCESTOR),
  )
}

interface TextRuns {
  nodes: Text[]
  /** Start offset of each node in `text`. */
  starts: number[]
  /** The code's text without its hints. */
  text: string
}

/**
 * The Text children of `code` and their concatenation, or null when `code` holds anything but
 * Text and hint spans (an element the engine does not know: leave the code alone).
 */
function textRuns(code: Element): TextRuns | null {
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  for (const child of Array.from(code.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      nodes.push(child as Text)
      starts.push(text.length)
      text += (child as Text).data
    } else if (
      !(
        child.nodeType === Node.ELEMENT_NODE &&
        (child as Element).classList.contains(WRAP_HINT_CLASS)
      )
    )
      return null
  }
  return { nodes, starts, text }
}

/** Offsets in the code's text where a hint span sits, ascending. */
export function readHintOffsets(code: Element): number[] {
  const offsets: number[] = []
  let length = 0
  for (const child of Array.from(code.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) length += (child as Text).length
    else if ((child as Element).classList?.contains(WRAP_HINT_CLASS))
      offsets.push(length)
  }
  return offsets
}

const sameOffsets = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index])

/**
 * One hint at `offset` of the code's text: inside a Text node it splits the node; on the boundary
 * of two adjacent Text nodes (Vditor's caret marker leaves such a split behind) it goes between
 * them. Nothing happens for an offset the text does not have.
 */
function insertHintAt(runs: TextRuns, offset: number): void {
  const inside = runs.starts.findIndex(
    (start, i) => start < offset && offset < start + runs.nodes[i].length,
  )
  if (inside !== -1) {
    insertWrapHint(runs.nodes[inside], offset - runs.starts[inside])
    return
  }
  const boundary = runs.starts.findIndex(
    (start, i) => i > 0 && start === offset,
  )
  if (boundary !== -1) insertWrapHintBefore(runs.nodes[boundary])
}

/**
 * Make the hints of `code` exactly `offsets` (offsets in its text). Writes nothing and returns
 * false when it already does. Otherwise the old hints go (`Node.normalize` merges the text again
 * and keeps a live Selection on its characters) and the new ones are inserted from the end, so
 * every earlier offset stays valid.
 */
export function rewriteHints(
  code: Element,
  offsets: readonly number[],
): boolean {
  const runs = textRuns(code)
  if (!runs) return false
  const wanted = [...new Set(offsets)]
    .filter((offset) => offset > 0 && offset < runs.text.length)
    .sort((a, b) => a - b)
  if (sameOffsets(readHintOffsets(code), wanted)) return false
  clearWrapHints(code)
  for (let index = wanted.length - 1; index >= 0; index -= 1) {
    const target = textRuns(code)
    if (!target) return true
    insertHintAt(target, wanted[index])
  }
  expectOwnTexts(code)
  return true
}

// ---------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------

/** The Range-rect width of `[from, to)` in the code's text, summed over its line fragments. */
function rangeWidth(
  range: Range,
  runs: TextRuns,
  from: number,
  to: number,
): number {
  const locate = (offset: number, atEnd: boolean): [Text, number] => {
    for (let i = 0; i < runs.nodes.length; i += 1) {
      const start = runs.starts[i]
      const end = start + runs.nodes[i].length
      if (offset < end || (atEnd && offset === end))
        return [runs.nodes[i], offset - start]
    }
    const last = runs.nodes[runs.nodes.length - 1]
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
  /** Width of the line box available to the code's text, px. */
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

/** The line box of `code`, or null when it has no layout (hidden, detached, not rendered yet). */
function lineBoxOf(
  code: HTMLElement,
  containers: Map<Element, number>,
): LineBox | null {
  const container =
    code.closest<HTMLElement>(LINE_CONTAINER) ?? code.parentElement
  if (!container) return null
  let containerWidth = containers.get(container)
  if (containerWidth === undefined) {
    const style = getComputedStyle(container)
    containerWidth =
      container.clientWidth - px(style.paddingLeft) - px(style.paddingRight)
    containers.set(container, containerWidth)
  }
  if (containerWidth <= 0) return null
  const style = getComputedStyle(code)
  const fontKey = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const boxEdges =
    px(style.paddingLeft) +
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
// Planning one code element
// ---------------------------------------------------------------------------------------------

export interface WrapHintOptions {
  /** The `minLastPiece` rule (graphemes); default 3. */
  minLastPiece?: number
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

/** Everything `planCodeOffsets` shares across the codes of one slice. */
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
  runs: TextRuns,
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
      rangeWidth(context.range, runs, start + from, start + to),
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
 * The hint offsets (in the code's text) the code should carry, or what it carries now when it has
 * no layout. Reads only: the caller writes afterwards.
 */
function planCodeOffsets(
  code: HTMLElement,
  containers: Map<Element, number>,
  context: PlanContext,
): number[] {
  const runs = textRuns(code)
  const box = runs ? lineBoxOf(code, containers) : null
  if (!(runs && box)) return readHintOffsets(code)
  const offsets: number[] = []
  for (const match of runs.text.matchAll(WORD)) {
    const word = match[0]
    if (!mayExceedLine(word, box, context.stats)) continue
    const start = match.index ?? 0
    for (const position of planWord(word, start, runs, box, context))
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
}

/** What one slice of reads decided: codes to rewrite and how long the typing pause still lasts. */
interface SliceResult {
  writes: Array<[Element, HTMLElement, number[]]>
  blocks: number
  waitFor: number
}

class WrapHintEngine {
  private readonly surfaces = new Map<HTMLElement, SurfaceState>()
  /** Top-level blocks inside the observer margin. */
  private readonly near = new Set<Element>()
  /** Near blocks whose code has not been looked at since the last change. */
  private readonly pending = new Set<Element>()
  /** The generation a block was last planned in; a layout change bumps `generation`. */
  private readonly plannedIn = new WeakMap<Element, number>()
  private readonly context: PlanContext
  private generation = 0
  private lastInputAt = Number.NEGATIVE_INFINITY
  private frame = 0
  private retry: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly getSurfaces: () => Array<HTMLElement | null | undefined>,
    private readonly stats: WrapHintStats | null,
    minLastPiece: number,
  ) {
    this.context = {
      range: document.createRange(),
      plans: new Map(),
      minLastPiece,
      stats,
    }
    document.fonts?.addEventListener('loadingdone', this.bumpGeneration)
    this.syncSurfaces()
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
    if (this.retry !== undefined) clearTimeout(this.retry)
    document.fonts?.removeEventListener('loadingdone', this.bumpGeneration)
    for (const state of [...this.surfaces.values()]) this.removeSurface(state)
    this.near.clear()
    this.pending.clear()
    this.context.plans.clear()
  }

  // Triggers ------------------------------------------------------------------------------------

  private readonly bumpGeneration = (): void => {
    this.generation += 1
    for (const block of this.near) this.pending.add(block)
    this.schedule()
  }

  private readonly onInput = (): void => {
    this.lastInputAt = performance.now()
  }

  private schedule(): void {
    if (this.disposed || this.frame !== 0) return
    // Two frames: the first geometry read after a trigger lays out whatever just became relevant
    // (S1 probe 4); by the second frame that cost is paid and the reads are cheap.
    this.frame = requestAnimationFrame(() => {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0
        this.run()
      })
    })
  }

  private onIntersections(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        this.near.delete(entry.target)
        this.pending.delete(entry.target)
      } else {
        this.near.add(entry.target)
        if (this.plannedIn.get(entry.target) !== this.generation)
          this.pending.add(entry.target)
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
    if (record.type !== 'childList' || record.target !== state.surface) {
      this.markDirty(topLevelBlock(state.surface, record.target))
      return
    }
    for (const node of Array.from(record.removedNodes))
      if (node instanceof Element) this.untrackBlock(state, node)
    for (const node of Array.from(record.addedNodes))
      if (node instanceof Element) this.trackBlock(state, node)
  }

  private markDirty(block: Element | null): void {
    if (!block) return
    this.plannedIn.delete(block)
    if (this.near.has(block)) this.pending.add(block)
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
    this.near.delete(block)
    this.pending.delete(block)
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
    }
    state.mutations.observe(surface, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    if (typeof ResizeObserver !== 'undefined') {
      state.resize = new ResizeObserver(() => this.onSurfaceResize(state))
      state.resize.observe(surface)
    }
    // A user edit (typing, deleting, composing) starts the pause that keeps the edited block's
    // hints off until the typing stops.
    surface.addEventListener('beforeinput', this.onInput, true)
    surface.addEventListener('compositionend', this.onInput, true)
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
    for (const block of state.tracked) {
      this.near.delete(block)
      this.pending.delete(block)
    }
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

  /** Is the caret or selection inside `code` while an edit is recent? */
  private holdsActiveCaret(code: Element): boolean {
    if (performance.now() - this.lastInputAt >= TYPING_PAUSE_MS) return false
    const selection = window.getSelection()
    return Boolean(
      selection &&
        selection.rangeCount > 0 &&
        code.contains(selection.anchorNode),
    )
  }

  /** Plan every inline code of one block; true when some code waits for the typing pause. */
  private planBlock(
    block: Element,
    containers: Map<Element, number>,
    result: SliceResult,
  ): boolean {
    let deferred = false
    for (const code of inlineCodesWithin(block)) {
      if (this.stats) this.stats.codes += 1
      const offsets = planCodeOffsets(code, containers, this.context)
      if (sameOffsets(readHintOffsets(code), offsets)) continue
      if (!this.holdsActiveCaret(code)) {
        result.writes.push([block, code, offsets])
        continue
      }
      // The edited code waits for the typing pause (Vditor rebuilds the block on input anyway).
      deferred = true
      if (this.stats) this.stats.deferred += 1
      result.waitFor = Math.max(
        result.waitFor,
        TYPING_PAUSE_MS - (performance.now() - this.lastInputAt),
      )
    }
    return deferred
  }

  /** Read phase: plan near, changed blocks until the frame budget is spent. */
  private readSlice(started: number): SliceResult {
    const containers = new Map<Element, number>()
    const result: SliceResult = { writes: [], blocks: 0, waitFor: 0 }
    for (const block of [...this.pending]) {
      if (!(block.isConnected && this.near.has(block))) {
        this.pending.delete(block)
        continue
      }
      const deferred = this.planBlock(block, containers, result)
      result.blocks += 1
      if (!deferred) {
        this.pending.delete(block)
        this.plannedIn.set(block, this.generation)
      }
      if (performance.now() - started > FRAME_BUDGET_MS) break
    }
    return result
  }

  private run(): void {
    if (this.disposed) return
    if (isCompositionActive()) {
      this.retry = setTimeout(() => this.schedule(), 100)
      return
    }
    this.syncSurfaces()
    const started = performance.now()
    const result = this.readSlice(started)
    const readEnd = performance.now()
    // One write phase: nothing below reads layout. It stops at its own budget; the blocks of the
    // codes it did not reach are planned again next frame (their plans are cached).
    const hints = this.writeSlice(result.writes)
    this.record(started, readEnd, result, hints)
    if (result.waitFor > 0)
      this.retry = setTimeout(() => this.schedule(), result.waitFor + 20)
    else if (this.pending.size > 0) this.schedule()
  }

  private writeSlice(writes: SliceResult['writes']): number {
    const started = performance.now()
    let hints = 0
    for (const [index, [, code, offsets]] of writes.entries()) {
      if (index > 0 && performance.now() - started > WRITE_BUDGET_MS) {
        for (const [block] of writes.slice(index)) {
          this.plannedIn.delete(block)
          this.pending.add(block)
        }
        break
      }
      if (rewriteHints(code, offsets)) hints += offsets.length
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
  )
  return () => engine.dispose()
}
