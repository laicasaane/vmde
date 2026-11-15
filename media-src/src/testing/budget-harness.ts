// Task 733 / 012-19 — test-only harness for the counted budget tests (D-13 design section 5.1).
// It imports only `real-lute` from its own manifest module: `testing->util` and `testing->editing`
// are not allowed edges, so the lane interface is declared here structurally and every fixture
// preparation (for example the webview's code-source tagging) is passed in by the test.
//
// Counting works by wrapping DOM prototypes for the duration of one synchronous `countBudget` run and
// restoring them afterwards, so nothing outside a run is slowed down or observed. Every wrapper
// forwards `this` and the arguments to the original and returns its result unchanged.

import { createRealLute, type RealLute } from './real-lute'

export type Factor = 1 | 4 | 16

export interface BudgetCounts {
  /** querySelector*, getElementsBy* with the root, `#app` or the document as receiver. */
  rootQueries: number
  /** The same with a table as receiver. */
  tableQueries: number
  /** TreeWalker and NodeIterator steps plus counted child iteration (sibling and child getters, NodeList and HTMLCollection iteration). */
  nodesWalked: number
  /** getBoundingClientRect, getClientRects, offset*, client*, scroll* reads. */
  layoutReads: number
  /** Calls on a Lute object passed through `countedLute`. */
  luteCalls: number
  /** Summed input length of those calls. */
  luteChars: number
  /** Selection writes plus live-range mutations of getRangeAt() results. */
  selectionWrites: number
  /** <style> and <link rel=stylesheet> nodes connected or removed. */
  styleInsertions: number
  /** innerHTML/outerHTML getters on tables, lists, code blocks and the root. */
  innerHtmlReads: number
  /** Element descendants of the receiver, summed over every querySelector and getElementsBy call (any receiver). */
  queriedNodes: number
  /**
   * Layout-dependent calls (layout reads, selection writes, live-range mutations) made while a
   * counted DOM write has left layout dirty; each such call clears the dirty state (D-13 section 11.3).
   */
  flushes: number
}

interface Charges {
  luteCallMs: number
  luteMsPer1000Chars: number
  layoutReadMs: number
  rootQueryMsPer1000Elements: number
  nodeMs: number
  cellMountMs: number
}

const DEFAULT_CHARGES: Charges = {
  luteCallMs: 0.5,
  luteMsPer1000Chars: 0.1,
  layoutReadMs: 1,
  rootQueryMsPer1000Elements: 0.05,
  nodeMs: 0.001,
  cellMountMs: 0.2,
}

interface ChargingClock {
  charges: Charges
  advance(ms: number): void
}

// The newest cost clock is the one counted operations charge during a `countBudget` run; each test
// creates its own clock, so the newest one is the test's.
let chargingClock: ChargingClock | undefined

/** A fake clock that advances by a fixed charge per counted operation; drives M1 deadlines deterministically. */
export function costClock(charges?: Partial<Charges>): {
  now(): number
  advance(ms: number): void
} {
  let time = 0
  const clock = {
    now: () => time,
    advance(ms: number): void {
      time += ms
    },
  }
  chargingClock = {
    charges: { ...DEFAULT_CHARGES, ...charges },
    advance: clock.advance,
  }
  return clock
}

/** Fake animation frames and idle callbacks for createBackgroundScheduler. */
export interface LaneDeps {
  now(): number
  requestAnimationFrame(callback: () => void): number
  cancelAnimationFrame(handle: number): void
  requestIdle(callback: (deadline: { timeRemaining(): number }) => void): number
  cancelIdle(handle: number): void
  inputPending(): boolean
}

/**
 * Lanes driven by the test: `runFrame()` runs the frame callbacks queued before the call (callbacks
 * queued while they run wait for the next frame); `runIdle(t)` does the same for idle callbacks with
 * a deadline of `t` ms measured on `clock` from the call. `inputPending` returns false; a test
 * replaces the method on the returned object to report pending input.
 */
export function fakeLanes(clock: { now(): number }): LaneDeps & {
  runFrame(): void
  runIdle(timeRemaining: number): void
} {
  let nextHandle = 1
  let frames = new Map<number, () => void>()
  let idles = new Map<number, (deadline: { timeRemaining(): number }) => void>()
  return {
    now: () => clock.now(),
    requestAnimationFrame(callback) {
      const handle = nextHandle++
      frames.set(handle, callback)
      return handle
    },
    cancelAnimationFrame(handle) {
      frames.delete(handle)
    },
    requestIdle(callback) {
      const handle = nextHandle++
      idles.set(handle, callback)
      return handle
    },
    cancelIdle(handle) {
      idles.delete(handle)
    },
    inputPending: () => false,
    runFrame() {
      const due = frames
      frames = new Map()
      for (const callback of due.values()) callback()
    },
    runIdle(timeRemaining) {
      const due = idles
      idles = new Map()
      const start = clock.now()
      const deadline = {
        timeRemaining: () => Math.max(0, timeRemaining - (clock.now() - start)),
      }
      for (const callback of due.values()) callback(deadline)
    },
  }
}

// ---- fixtures ----

let fixtureLute: RealLute | undefined
const renderedHtml = new Map<string, string>()
const builtFixtures = new Map<
  string,
  Map<((root: HTMLElement) => void) | undefined, HTMLElement>
>()

/** Mounts `html` as `div.vditor-ir > pre.vditor-reset` under the document body and returns the `pre`. */
function mountIrRoot(html: string): HTMLElement {
  const container = document.createElement('div')
  container.className = 'vditor-ir'
  const root = document.createElement('pre')
  root.className = 'vditor-reset'
  root.setAttribute('contenteditable', 'true')
  root.innerHTML = html
  container.append(root)
  document.body.append(container)
  return root
}

/** IR DOM of `markdown` (the test passes tableHeavyMarkdown(factor)) built with createRealLute('ir').render,
 *  mounted under a jsdom root `div.vditor-ir > pre.vditor-reset`, then `prepare(root)`; built once per file,
 *  markdown and prepare. Tests whose path depends on webview tagging pass it (code block paths:
 *  `tagCodeSource` from `E/code-source.ts` and the probe's `vditor-ir__node--expand` class, as 012-11's
 *  `probeCodeBlock`), because raw Lute DOM hid the C6 gap. */
export function irFixture(
  markdown: string,
  prepare?: (root: HTMLElement) => void,
): { root: HTMLElement } {
  let byPrepare = builtFixtures.get(markdown)
  if (!byPrepare) {
    byPrepare = new Map()
    builtFixtures.set(markdown, byPrepare)
  }
  let root = byPrepare.get(prepare)
  if (!root) {
    let html = renderedHtml.get(markdown)
    if (html === undefined) {
      fixtureLute ??= createRealLute('ir')
      html = fixtureLute.render(markdown)
      renderedHtml.set(markdown, html)
    }
    root = mountIrRoot(html)
    prepare?.(root)
    byPrepare.set(prepare, root)
  }
  return { root }
}

/** A DOM of the same shape without Lute, for pure DOM consumers: tables x rows x 5 cells, list items, paragraphs. */
export function scaledFixture(shape: {
  tables: number
  rows: number
  listItems: number
  paragraphs: number
}): HTMLElement {
  const parts: string[] = []
  for (let p = 1; p <= shape.paragraphs; p++)
    parts.push(`<p data-block="0">Paragraph ${p}</p>`)
  if (shape.listItems > 0) {
    parts.push('<ul data-tight="true" data-marker="*" data-block="0">')
    for (let i = 1; i <= shape.listItems; i++)
      parts.push(`<li data-marker="*">Item ${i}</li>`)
    parts.push('</ul>')
  }
  for (let t = 1; t <= shape.tables; t++) {
    parts.push('<table data-block="0" data-type="table"><thead><tr>')
    for (let c = 1; c <= 5; c++) parts.push(`<th>H${c}</th>`)
    parts.push('</tr></thead><tbody>')
    for (let r = 1; r <= shape.rows; r++) {
      parts.push('<tr>')
      for (let c = 1; c <= 5; c++) parts.push(`<td>t${t} r${r} c${c}</td>`)
      parts.push('</tr>')
    }
    parts.push('</tbody></table>')
  }
  return mountIrRoot(parts.join(''))
}

// ---- counting ----

interface ActiveRun {
  root: HTMLElement
  counts: BudgetCounts
  // Set by a counted DOM write, cleared by the next layout-dependent call (which counts a flush).
  dirty: boolean
}

let active: ActiveRun | undefined
// Raised while the harness itself reads the DOM (descendant counts, cell counts), so its own reads
// are never counted or charged.
let quiet = 0

// jsdom implements selectors (and so `matches` and `closest`) on top of the public child getters, so
// every original runs quiet: only the caller's own operations are counted, never the engine's.
function native(
  original: (...args: any[]) => any,
  receiver: unknown,
  args: unknown[],
): any {
  quiet++
  try {
    return original.apply(receiver, args)
  } finally {
    quiet--
  }
}

function charge(ms: number): void {
  if (ms > 0) chargingClock?.advance(ms)
}

function counting(): ActiveRun | undefined {
  return quiet === 0 ? active : undefined
}

function zeroCounts(): BudgetCounts {
  return {
    rootQueries: 0,
    tableQueries: 0,
    nodesWalked: 0,
    layoutReads: 0,
    luteCalls: 0,
    luteChars: 0,
    selectionWrites: 0,
    styleInsertions: 0,
    innerHtmlReads: 0,
    queriedNodes: 0,
    flushes: 0,
  }
}

const wrappedLutes = new WeakSet<object>()
// Lute's conversion methods (Md2VditorIRDOM, VditorIRDOM2Md, Md2HTML, ...) and its spin methods.
const LUTE_METHOD = /^(?:[A-Za-z]+2[A-Za-z]+|Spin[A-Za-z]+)$/

/**
 * Wraps the conversion and spin methods of `lute` in place (once) so calls made during a
 * `countBudget` run count as `luteCalls` and `luteChars` and charge the cost clock. Returns `lute`.
 */
export function countedLute<T extends object>(lute: T): T {
  if (wrappedLutes.has(lute)) return lute
  wrappedLutes.add(lute)
  const target = lute as Record<string, unknown>
  for (const name in target) {
    const original = target[name]
    if (typeof original !== 'function' || !LUTE_METHOD.test(name)) continue
    target[name] = function (this: unknown, ...args: unknown[]) {
      const run = counting()
      if (run) {
        const input = typeof args[0] === 'string' ? args[0] : ''
        run.counts.luteCalls++
        run.counts.luteChars += input.length
        const charges = chargingClock?.charges
        if (charges)
          charge(
            charges.luteCallMs +
              (charges.luteMsPer1000Chars * input.length) / 1000,
          )
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args)
    }
  }
  return lute
}

type Restore = () => void

function patchMethod(
  proto: object | undefined,
  name: string | symbol,
  wrap: (original: (...args: any[]) => any) => (...args: any[]) => any,
  restores: Restore[],
): void {
  if (!proto) return
  const descriptor = Object.getOwnPropertyDescriptor(proto, name)
  if (!descriptor || typeof descriptor.value !== 'function') return
  Object.defineProperty(proto, name, {
    ...descriptor,
    value: wrap(descriptor.value),
  })
  restores.push(() => Object.defineProperty(proto, name, descriptor))
}

function patchAccessor(
  proto: object | undefined,
  name: string,
  wrap: {
    get?: (original: () => unknown) => () => unknown
    set?: (original: (value: unknown) => void) => (value: unknown) => void
  },
  restores: Restore[],
): void {
  if (!proto) return
  const descriptor = Object.getOwnPropertyDescriptor(proto, name)
  if (!descriptor?.get) return
  Object.defineProperty(proto, name, {
    ...descriptor,
    get: wrap.get ? wrap.get(descriptor.get) : descriptor.get,
    set: wrap.set && descriptor.set ? wrap.set(descriptor.set) : descriptor.set,
  })
  restores.push(() => Object.defineProperty(proto, name, descriptor))
}

function elementDescendants(node: Node): number {
  quiet++
  try {
    let count = 0
    const walker = node.ownerDocument
      ? node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_ELEMENT)
      : (node as Document).createTreeWalker(node, NodeFilter.SHOW_ELEMENT)
    while (walker.nextNode()) count++
    return count
  } finally {
    quiet--
  }
}

function cellsIn(node: unknown): number {
  if (!(node instanceof Element) && !(node instanceof DocumentFragment))
    return 0
  quiet++
  try {
    const self =
      node instanceof Element &&
      (node.localName === 'td' || node.localName === 'th')
        ? 1
        : 0
    return self + node.querySelectorAll('td, th').length
  } finally {
    quiet--
  }
}

function isRootReceiver(receiver: unknown, root: HTMLElement): boolean {
  if (receiver === root) return true
  if (receiver instanceof Document) return true
  return receiver instanceof Element && receiver.id === 'app'
}

function isInnerHtmlTarget(element: Element, root: HTMLElement): boolean {
  if (element === root) return true
  const name = element.localName
  if (name === 'table' || name === 'ul' || name === 'ol') return true
  if (element.getAttribute('data-type') === 'code-block') return true
  return (
    (name === 'pre' || name === 'code') &&
    element.closest('[data-type="code-block"]') !== null
  )
}

function isStyleNode(node: Node): boolean {
  if (!(node instanceof Element)) return false
  if (node.localName === 'style') return true
  return (
    node.localName === 'link' &&
    (node.getAttribute('rel') ?? '').split(/\s+/).includes('stylesheet')
  )
}

function styleNodesIn(node: Node): number {
  let count = isStyleNode(node) ? 1 : 0
  if (node instanceof Element || node instanceof DocumentFragment) {
    quiet++
    try {
      for (const child of node.querySelectorAll('style, link'))
        if (isStyleNode(child)) count++
    } finally {
      quiet--
    }
  }
  return count
}

const QUERY_METHODS = [
  'querySelector',
  'querySelectorAll',
  'getElementsByTagName',
  'getElementsByTagNameNS',
  'getElementsByClassName',
  'getElementsByName',
]
const TREE_WALKER_STEPS = [
  'nextNode',
  'previousNode',
  'firstChild',
  'lastChild',
  'nextSibling',
  'previousSibling',
]
const CHILD_GETTERS = [
  'firstChild',
  'lastChild',
  'nextSibling',
  'previousSibling',
  'firstElementChild',
  'lastElementChild',
  'nextElementSibling',
  'previousElementSibling',
]
const LAYOUT_METHODS = ['getBoundingClientRect', 'getClientRects']
const LAYOUT_GETTERS = [
  'offsetTop',
  'offsetLeft',
  'offsetWidth',
  'offsetHeight',
  'offsetParent',
  'clientTop',
  'clientLeft',
  'clientWidth',
  'clientHeight',
  'scrollTop',
  'scrollLeft',
  'scrollWidth',
  'scrollHeight',
]
const SELECTION_WRITES = [
  'addRange',
  'removeRange',
  'removeAllRanges',
  'empty',
  'collapse',
  'setPosition',
  'collapseToStart',
  'collapseToEnd',
  'extend',
  'setBaseAndExtent',
  'selectAllChildren',
  'modify',
]
const RANGE_WRITES = [
  'setStart',
  'setEnd',
  'setStartBefore',
  'setStartAfter',
  'setEndBefore',
  'setEndAfter',
  'collapse',
  'selectNode',
  'selectNodeContents',
]
const INSERTIONS = [
  'append',
  'prepend',
  'before',
  'after',
  'replaceWith',
  'insertAdjacentElement',
]

type Prototypes = object[]

function ownersOf(win: typeof window): Prototypes {
  return [
    win.Element.prototype,
    win.Document.prototype,
    win.DocumentFragment.prototype,
  ]
}

function countQuery(receiver: Node): void {
  const run = counting()
  if (!run) return
  const descendants = elementDescendants(receiver)
  run.counts.queriedNodes += descendants
  if (isRootReceiver(receiver, run.root)) {
    run.counts.rootQueries++
    const charges = chargingClock?.charges
    if (charges)
      charge((charges.rootQueryMsPer1000Elements * descendants) / 1000)
  }
  if (receiver instanceof Element && receiver.localName === 'table')
    run.counts.tableQueries++
}

function patchQueries(win: typeof window, restores: Restore[]): void {
  for (const proto of ownersOf(win))
    for (const name of QUERY_METHODS)
      patchMethod(
        proto,
        name,
        (original) =>
          function (this: Node, ...args: unknown[]) {
            countQuery(this)
            return native(original, this, args)
          },
        restores,
      )
  for (const name of ['matches', 'closest', 'webkitMatchesSelector'])
    patchMethod(
      win.Element.prototype,
      name,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          return native(original, this, args)
        },
      restores,
    )
}

function countWalk(stepped: unknown): void {
  const run = counting()
  if (!run || stepped === null || stepped === undefined) return
  run.counts.nodesWalked++
  const charges = chargingClock?.charges
  if (charges) charge(charges.nodeMs)
}

function patchWalks(win: typeof window, restores: Restore[]): void {
  for (const proto of [win.TreeWalker.prototype, win.NodeIterator.prototype])
    for (const name of TREE_WALKER_STEPS)
      patchMethod(
        proto,
        name,
        (original) =>
          function (this: unknown, ...args: unknown[]) {
            const result = native(original, this, args)
            countWalk(result)
            return result
          },
        restores,
      )
  for (const proto of [win.Node.prototype, ...ownersOf(win)])
    for (const name of CHILD_GETTERS)
      patchAccessor(
        proto,
        name,
        {
          get: (original) =>
            function (this: unknown) {
              const result = native(original, this, [])
              countWalk(result)
              return result
            },
        },
        restores,
      )
  for (const proto of [win.NodeList.prototype, win.HTMLCollection.prototype])
    patchMethod(
      proto,
      Symbol.iterator,
      (original) =>
        function* (this: unknown) {
          for (const item of original.call(this) as Iterable<unknown>) {
            countWalk(item)
            yield item
          }
        },
      restores,
    )
  patchMethod(
    win.NodeList.prototype,
    'forEach',
    (original) =>
      function (this: unknown, callback: (...a: unknown[]) => void, ...rest) {
        return original.call(
          this,
          function (this: unknown, item: unknown, ...more: unknown[]) {
            countWalk(item)
            return callback.call(this, item, ...more)
          },
          ...rest,
        )
      },
    restores,
  )
}

function markDirty(): void {
  const run = counting()
  if (run) run.dirty = true
}

/** A layout-dependent call: with layout dirty from a counted DOM write it forces one flush. */
function countFlush(run: ActiveRun): void {
  if (!run.dirty) return
  run.counts.flushes++
  run.dirty = false
}

function countLayout(): void {
  const run = counting()
  if (!run) return
  countFlush(run)
  run.counts.layoutReads++
  const charges = chargingClock?.charges
  if (charges) charge(charges.layoutReadMs)
}

function patchLayout(win: typeof window, restores: Restore[]): void {
  for (const proto of [win.Element.prototype, win.Range.prototype])
    for (const name of LAYOUT_METHODS)
      patchMethod(
        proto,
        name,
        (original) =>
          function (this: unknown, ...args: unknown[]) {
            countLayout()
            return native(original, this, args)
          },
        restores,
      )
  for (const proto of [win.HTMLElement.prototype, win.Element.prototype])
    for (const name of LAYOUT_GETTERS)
      patchAccessor(
        proto,
        name,
        {
          get: (original) =>
            function (this: unknown) {
              countLayout()
              return native(original, this, [])
            },
        },
        restores,
      )
}

function countSelectionWrite(): void {
  const run = counting()
  if (!run) return
  countFlush(run)
  run.counts.selectionWrites++
}

function patchSelection(win: typeof window, restores: Restore[]): void {
  // Ranges handed out by getRangeAt() are the selection's live ranges in a browser; mutating one
  // moves the selection, so it counts as a selection write. A cloned or created range does not.
  const liveRanges = new WeakSet<object>()
  const selectionProto = win.Selection?.prototype
  for (const name of SELECTION_WRITES)
    patchMethod(
      selectionProto,
      name,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          countSelectionWrite()
          return native(original, this, args)
        },
      restores,
    )
  patchMethod(
    selectionProto,
    'getRangeAt',
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        const range = native(original, this, args)
        if (range) liveRanges.add(range)
        return range
      },
    restores,
  )
  for (const name of RANGE_WRITES)
    patchMethod(
      win.Range.prototype,
      name,
      (original) =>
        function (this: object, ...args: unknown[]) {
          if (liveRanges.has(this)) countSelectionWrite()
          return native(original, this, args)
        },
      restores,
    )
}

// Mounted cells charge the cost clock at insertion time, so a deadline check right after a fill
// batch sees the charge. Cells inserted through an HTML setter are charged after the write.
function chargeCells(cells: number, parent: Node | null): void {
  const charges = chargingClock?.charges
  if (!charges || cells === 0 || !counting() || !parent?.isConnected) return
  charge(charges.cellMountMs * cells)
}

function cellsOfArgs(args: unknown[]): number {
  let cells = 0
  for (const arg of args) cells += cellsIn(arg)
  return cells
}

/** The node whose connection decides whether an insertion mounts its cells. */
function insertionParent(receiver: Node, method: string): Node | null {
  return method === 'before' || method === 'after' || method === 'replaceWith'
    ? receiver.parentNode
    : receiver
}

// ---- style insertions ----
//
// `styleInsertions` is counted inside the DOM-write wrappers, not by a MutationObserver: test-only
// code registers no observer site (the observer freeze list in `test/backend/observer-registry.test.ts`
// covers every non-test source file). A probe runs before the write and returns a finisher that runs
// after it; both run quiet, so their own reads are never counted.

type StyleFinisher = () => number
type StyleProbe = (receiver: any, args: unknown[]) => StyleFinisher

/** Style nodes in `node` when it is connected (it leaves the document if the write moves or removes it). */
function leavingStyles(node: unknown): number {
  return node instanceof Node && node.isConnected ? styleNodesIn(node) : 0
}

/** Style nodes strictly inside `node` when it is connected (an HTML setter replaces them). */
function descendantStyles(node: Node): number {
  if (!node.isConnected) return 0
  return styleNodesIn(node) - (isStyleNode(node) ? 1 : 0)
}

/** Style nodes among the children of `parent` after `start` and before `end` (null = the edges). */
function stylesBetween(
  parent: Node | null,
  start: Node | null,
  end: Node | null,
): number {
  if (!parent?.isConnected) return 0
  let count = 0
  let node = start ? start.nextSibling : parent.firstChild
  while (node && node !== end) {
    count += styleNodesIn(node)
    node = node.nextSibling
  }
  return count
}

/**
 * Inserting `nodes`: a connected node leaves its old place first; every node arrives when the
 * insertion target is connected after the write. A fragment is never connected and is counted
 * before the write, while it still holds its children.
 */
function insertionProbe(
  nodes: unknown[],
  target: () => Node | null,
  removed = 0,
): StyleFinisher {
  let leaving = removed
  let arriving = 0
  for (const node of nodes) {
    if (!(node instanceof Node)) continue
    const styles = styleNodesIn(node)
    arriving += styles
    if (node.isConnected) leaving += styles
  }
  return () => leaving + (target()?.isConnected ? arriving : 0)
}

function adjacentHtmlProbe(
  receiver: Element,
  position: unknown,
): StyleFinisher {
  const where = String(position).toLowerCase()
  if (where === 'afterbegin') {
    const end = receiver.firstChild
    return () => stylesBetween(receiver, null, end)
  }
  if (where === 'beforeend') {
    const start = receiver.lastChild
    return () => stylesBetween(receiver, start, null)
  }
  const parent = receiver.parentNode
  if (where === 'beforebegin') {
    const start = receiver.previousSibling
    return () => stylesBetween(parent, start, receiver)
  }
  const end = receiver.nextSibling
  return () => stylesBetween(parent, receiver, end)
}

function outerHtmlProbe(receiver: Element): StyleFinisher {
  const removed = leavingStyles(receiver)
  const parent = receiver.parentNode
  const start = receiver.previousSibling
  const end = receiver.nextSibling
  return () => removed + stylesBetween(parent, start, end)
}

function sideways(receiver: Node, args: unknown[], removed = 0): StyleFinisher {
  const parent = receiver.parentNode
  return insertionProbe(args, () => parent, removed)
}

const STYLE_PROBES: Record<string, StyleProbe> = {
  appendChild: (receiver, args) => insertionProbe([args[0]], () => receiver),
  insertBefore: (receiver, args) => insertionProbe([args[0]], () => receiver),
  replaceChild: (receiver, args) =>
    insertionProbe([args[0]], () => receiver, leavingStyles(args[1])),
  append: (receiver, args) => insertionProbe(args, () => receiver),
  prepend: (receiver, args) => insertionProbe(args, () => receiver),
  before: (receiver, args) => sideways(receiver, args),
  after: (receiver, args) => sideways(receiver, args),
  replaceWith: (receiver, args) =>
    sideways(receiver, args, leavingStyles(receiver)),
  insertAdjacentElement: (receiver, args) =>
    insertionProbe([args[1]], () => receiver),
  removeChild: (_receiver, args) => {
    const removed = leavingStyles(args[0])
    return () => removed
  },
  remove: (receiver) => {
    const removed = leavingStyles(receiver)
    return () => removed
  },
  insertNode: (receiver: Range, args) => {
    const container = receiver.startContainer
    return insertionProbe([args[0]], () => container)
  },
  extractContents: (receiver: Range) => {
    // Approximation: a partially selected style element is cloned too, although it stays.
    const removed = receiver.commonAncestorContainer.isConnected
      ? styleNodesIn(receiver.cloneContents())
      : 0
    return () => removed
  },
  insertAdjacentHTML: (receiver, args) => adjacentHtmlProbe(receiver, args[0]),
  innerHTML: (receiver) => {
    const removed = descendantStyles(receiver)
    return () => removed + descendantStyles(receiver)
  },
  outerHTML: (receiver) => outerHtmlProbe(receiver),
  textContent: (receiver) => {
    const removed =
      receiver instanceof Element || receiver instanceof DocumentFragment
        ? descendantStyles(receiver)
        : 0
    return () => removed
  },
}
STYLE_PROBES.deleteContents = STYLE_PROBES.extractContents

/** Runs one counted DOM write: style probe, the original, the dirty flag (when `dirties`), style count. */
function countedWrite(
  name: string,
  original: (...args: any[]) => any,
  receiver: unknown,
  args: unknown[],
  dirties: boolean,
): any {
  const probe = STYLE_PROBES[name]
  const finish =
    probe && counting()
      ? native(() => probe(receiver, args), undefined, [])
      : undefined
  const result = native(original, receiver, args)
  if (dirties) markDirty()
  const run = counting()
  if (run && finish) run.counts.styleInsertions += native(finish, undefined, [])
  return result
}

function patchInsertions(win: typeof window, restores: Restore[]): void {
  for (const name of ['appendChild', 'insertBefore', 'replaceChild'])
    patchMethod(
      win.Node.prototype,
      name,
      (original) =>
        function (this: Node, ...args: unknown[]) {
          const cells = counting() ? cellsIn(args[0]) : 0
          const result = countedWrite(name, original, this, args, true)
          chargeCells(cells, this)
          return result
        },
      restores,
    )
  for (const proto of ownersOf(win))
    for (const name of INSERTIONS)
      patchMethod(
        proto,
        name,
        (original) =>
          function (this: Node, ...args: unknown[]) {
            const cells = counting() ? cellsOfArgs(args) : 0
            const parent = insertionParent(this, name)
            const result = countedWrite(name, original, this, args, false)
            chargeCells(cells, parent)
            return result
          },
        restores,
      )
}

function countHtmlRead(element: Element): void {
  const run = counting()
  if (run && isInnerHtmlTarget(element, run.root)) run.counts.innerHtmlReads++
}

function patchHtml(win: typeof window, restores: Restore[]): void {
  for (const name of ['innerHTML', 'outerHTML'])
    patchAccessor(
      win.Element.prototype,
      name,
      {
        get: (original) =>
          function (this: Element) {
            countHtmlRead(this)
            return native(original, this, [])
          },
        set: (original) =>
          function (this: Element, value: unknown) {
            countedWrite(name, original, this, [value], true)
            if (name === 'innerHTML' && counting())
              chargeCells(cellsIn(this), this)
          },
      },
      restores,
    )
}

// DOM writes that set the dirty state for `flushes` beyond the insertion methods and the HTML setters
// wrapped above (the write list of D-13 section 11.3).
function patchWrites(win: typeof window, restores: Restore[]): void {
  const writes: Array<[object | undefined, string]> = [
    [win.Node.prototype, 'removeChild'],
    [win.Element.prototype, 'remove'],
    [win.CharacterData.prototype, 'remove'],
    [win.DocumentType.prototype, 'remove'],
    [win.Range.prototype, 'insertNode'],
    [win.Range.prototype, 'extractContents'],
    [win.Range.prototype, 'deleteContents'],
    [win.Element.prototype, 'insertAdjacentHTML'],
    [win.Text.prototype, 'splitText'],
  ]
  for (const [proto, name] of writes)
    patchMethod(
      proto,
      name,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          return countedWrite(name, original, this, args, true)
        },
      restores,
    )
  for (const [proto, name] of [
    [win.Node.prototype, 'textContent'],
    [win.CharacterData.prototype, 'data'],
  ] as const)
    patchAccessor(
      proto,
      name,
      {
        set: (original) =>
          function (this: unknown, value: unknown) {
            countedWrite(name, original, this, [value], true)
          },
      },
      restores,
    )
}

function installCounting(win: typeof window): Restore[] {
  const restores: Restore[] = []
  patchWrites(win, restores)
  patchQueries(win, restores)
  patchWalks(win, restores)
  patchLayout(win, restores)
  patchSelection(win, restores)
  patchInsertions(win, restores)
  patchHtml(win, restores)
  return restores
}

/**
 * Runs `run` synchronously with the DOM counters installed and returns its result and the counts.
 * Runs do not nest. Operations charge the newest `costClock` while counted.
 */
export function countBudget<T>(
  root: HTMLElement,
  run: () => T,
): { result: T; counts: BudgetCounts } {
  if (active) throw new Error('countBudget runs do not nest')
  const win = root.ownerDocument.defaultView as typeof window
  const counts = zeroCounts()
  const restores = installCounting(win)
  active = { root, counts, dirty: false }
  try {
    const result = run()
    return { result, counts }
  } finally {
    active = undefined
    for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  }
}
