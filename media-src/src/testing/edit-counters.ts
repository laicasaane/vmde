// Task 733 — edit-path counters for end-to-end runs only. finish-init installs them when
// `window.__vmdeE2EReadiness` exists; in a product page nothing here runs, so no global is created
// and no prototype is wrapped. Every wrapper forwards `this` and the arguments to the original and
// returns its result unchanged; it only increments counters.

export interface EditCounters {
  fullGetValue: number
  luteDocument: number
  luteTable: number
  luteList: number
  luteBlock: number
  rootClone: number
  rootInnerHtmlRead: number
  legacyEditPosts: number
  deltaPosts: number
  historyDeltaPosts: number
  tableClone: number
  rootQueryAll: number
  maxPostBytes: number
  /** Task 733 / 015: `SpinVditorSVDOM` calls (the Source spin). Not classified as a document, table or list call. */
  luteSvSpin: number
  /** Task 733 / 015: the longest `SpinVditorSVDOM` input since the reset. */
  luteSvSpinChars: number
  fallbackPublications: number
  /** Task 733 / 012-19: Selection writes into a mode root (by the write's node argument, else the focused element). */
  selectionWrites: number
  reset(markdownLength: number): void
}

/** The parts of the Vditor wrapper and its internal instance that the counters touch. */
export interface VditorLike {
  getValue?: (...args: any[]) => any
  vditor?: {
    currentMode?: string
    lute?: Record<string, any>
    ir?: { element?: HTMLElement }
    wysiwyg?: { element?: HTMLElement }
    sv?: { element?: HTMLElement }
  }
}

declare global {
  interface Window {
    __vmdeEditCounters?: EditCounters
  }
}

type AnyFn = (...args: any[]) => any

const NUMBER_FIELDS = [
  'fullGetValue',
  'luteDocument',
  'luteTable',
  'luteList',
  'luteBlock',
  'rootClone',
  'rootInnerHtmlRead',
  'legacyEditPosts',
  'deltaPosts',
  'historyDeltaPosts',
  'tableClone',
  'rootQueryAll',
  'maxPostBytes',
  'luteSvSpin',
  'luteSvSpinChars',
  'fallbackPublications',
  'selectionWrites',
] as const

// Task 733 / 012-19 (D-13 design section 1.3): the Selection methods that write it. A
// `removeAllRanges` plus `addRange` pair counts 2.
const SELECTION_WRITES = [
  'addRange',
  'removeAllRanges',
  'setBaseAndExtent',
  'collapse',
  'collapseToStart',
  'collapseToEnd',
  'extend',
  'selectAllChildren',
] as const

const HTML_METHODS = ['VditorIRDOM2Md', 'SpinVditorIRDOM'] as const
const MARKDOWN_METHODS = ['Md2VditorIRDOM', 'Md2HTML'] as const
const MODES = ['ir', 'wysiwyg', 'sv'] as const

// Once-per-window state: the prototype wrappers and the `vscode` wrapper are installed once; the
// WeakSet tracks clones of a mode root so their `innerHTML` reads count too.
const windowsInstalled = new WeakSet<Window>()
// Every installed instance; its mode roots are read through it at call time, so a root created after
// install (a mode switch, a rebuilt editor) still counts.
const instancesInstalled = new Set<VditorLike>()
const rootClones = new WeakSet<Node>()
let rootHtmlLength = 0
let markdownLength = 0
// Set by install() for the newest Vditor instance; reset() calls it.
let measureRoot: () => number = () => 0

// A mode root is the editing element (`vditor.vditor.<mode>.element`, the `pre.vditor-reset` inside
// the `.vditor-<mode>` container), matched by identity: the container itself is not a root.
function isModeRoot(node: Element): boolean {
  for (const vditor of instancesInstalled) {
    const inner = vditor.vditor
    for (const mode of MODES) if (inner?.[mode]?.element === node) return true
  }
  return false
}

function isRootOrClone(node: unknown): boolean {
  if (!(node instanceof Element)) return false
  return rootClones.has(node) || isModeRoot(node)
}

/** True when `node` sits inside a mode root (the root itself excluded). */
function isInsideModeRoot(node: Node): boolean {
  for (let p = node.parentNode; p; p = p.parentNode)
    if (p instanceof Element && isModeRoot(p)) return true
  return false
}

function rootHtmlLengthOf(
  vditor: VditorLike,
  readInnerHtml: (el: Element) => string,
): number {
  const inner = vditor.vditor
  const mode = inner?.currentMode
  const element = mode
    ? (inner as Record<string, any>)[mode]?.element
    : undefined
  return element instanceof Element ? readInnerHtml(element).length : 0
}

const winOf = (win: Window) => win as unknown as typeof window

/** True when `node` is a mode root or sits inside one. */
function inModeRoot(node: Node | null | undefined): boolean {
  if (!node) return false
  return (node instanceof Element && isModeRoot(node)) || isInsideModeRoot(node)
}

/**
 * The node a Selection write targets, read from its arguments: the range start for `addRange`, the
 * first node argument for the others that take one. Undefined for the writes without a node
 * (`removeAllRanges`, `collapseToStart`, `collapseToEnd`, or `collapse(null)`).
 */
function writeTarget(name: string, args: any[]): Node | undefined {
  const first = args[0]
  if (name === 'addRange')
    return (first as Range | undefined)?.startContainer ?? undefined
  return first instanceof Node ? first : undefined
}

/**
 * Count the Selection writes of a mode root. Task 733 run 1 (P-1): reading `anchorNode` around the
 * write made Chromium update the selection after the operation's DOM write, a forced layout per
 * write in every probe row. The wrapper therefore reads no Selection property: it decides from the
 * write's own node argument, or, for a write without one, from the focused element (the mode root
 * holds focus while it is edited).
 */
function installSelectionWrappers(win: Window): void {
  const proto = winOf(win).Selection?.prototype as unknown as
    | Record<string, unknown>
    | undefined
  if (!proto) return
  for (const name of SELECTION_WRITES) {
    const original = proto[name] as AnyFn | undefined
    if (typeof original !== 'function') continue
    proto[name] = function (this: Selection, ...args: any[]) {
      const result = original.apply(this, args)
      const node = writeTarget(name, args) ?? win.document.activeElement
      if (inModeRoot(node)) win.__vmdeEditCounters!.selectionWrites++
      return result
    }
  }
}

/**
 * Prototype wrappers: deep clones of a mode root, deep clones of a table inside a mode root,
 * `querySelectorAll` calls on a mode root or `#app` (count only, no selector is read), and
 * `innerHTML` reads on a root or its clone.
 */
function installPrototypeWrappers(win: Window): void {
  const view = winOf(win)
  const proto = view.Node.prototype
  const originalClone = proto.cloneNode
  proto.cloneNode = function (this: Node, ...args: [boolean?]) {
    const clone = originalClone.apply(this, args)
    if (args[0] === true && isRootOrClone(this)) {
      win.__vmdeEditCounters!.rootClone++
      rootClones.add(clone)
    }
    if (
      args[0] === true &&
      this instanceof Element &&
      this.localName === 'table' &&
      isInsideModeRoot(this)
    )
      win.__vmdeEditCounters!.tableClone++
    return clone
  } as typeof proto.cloneNode

  const elementProto = view.Element.prototype
  const originalQueryAll = elementProto.querySelectorAll
  elementProto.querySelectorAll = function (this: Element, ...args: [string]) {
    if (this.id === 'app' || isModeRoot(this))
      win.__vmdeEditCounters!.rootQueryAll++
    return originalQueryAll.apply(this, args)
  } as typeof elementProto.querySelectorAll

  const descriptor = Object.getOwnPropertyDescriptor(elementProto, 'innerHTML')
  if (!descriptor?.get) return
  const originalGetter = descriptor.get
  Object.defineProperty(elementProto, 'innerHTML', {
    ...descriptor,
    get(this: Element) {
      if (isRootOrClone(this)) win.__vmdeEditCounters!.rootInnerHtmlRead++
      return originalGetter.call(this)
    },
  })
}

/**
 * Replace `win.vscode` with a forwarding wrapper that counts `postMessage`. The original object
 * may be frozen (a Proxy would break on its non-configurable members), so build a plain object.
 */
function installVscodeWrapper(win: Window): void {
  const original = win.vscode as any
  if (!original) return
  const wrapper: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(original)) {
    if (key === 'postMessage') continue
    const value = original[key]
    wrapper[key as string] =
      typeof value === 'function' ? value.bind(original) : value
  }
  wrapper.postMessage = (message: any, ...rest: unknown[]) => {
    countPost(win.__vmdeEditCounters!, message)
    return original.postMessage(message, ...rest)
  }
  win.vscode = wrapper as any
}

/** Per-instance wrappers: `getValue` and the four counted Lute methods. */
function installInstanceWrappers(win: Window, vditor: VditorLike): void {
  const originalGetValue = vditor.getValue
  if (typeof originalGetValue === 'function') {
    vditor.getValue = function (this: unknown, ...args: any[]) {
      win.__vmdeEditCounters!.fullGetValue++
      return originalGetValue.apply(this, args)
    }
  }
  const lute = vditor.vditor?.lute
  if (!lute) return
  for (const method of [...HTML_METHODS, ...MARKDOWN_METHODS]) {
    const original = lute[method] as AnyFn | undefined
    if (typeof original !== 'function') continue
    const isHtml = (HTML_METHODS as readonly string[]).includes(method)
    lute[method] = function (this: unknown, input: unknown, ...rest: any[]) {
      if (typeof input === 'string')
        classify(win.__vmdeEditCounters!, input, isHtml, method)
      return original.call(this, input, ...rest)
    }
  }
  // Task 733 / 015: the Source spin is counted by calls and its longest input only (D-3: one unit per key).
  const originalSvSpin = lute.SpinVditorSVDOM as AnyFn | undefined
  if (typeof originalSvSpin === 'function') {
    lute.SpinVditorSVDOM = function (
      this: unknown,
      input: unknown,
      ...rest: any[]
    ) {
      const counters = win.__vmdeEditCounters!
      counters.luteSvSpin++
      if (typeof input === 'string' && input.length > counters.luteSvSpinChars)
        counters.luteSvSpinChars = input.length
      return originalSvSpin.call(this, input, ...rest)
    }
  }
}

function install(win: Window, vditor: VditorLike): void {
  const getter = Object.getOwnPropertyDescriptor(
    winOf(win).Element.prototype,
    'innerHTML',
  )?.get
  // Unwrapped getter for the reset() measurement, so the measurement is never counted itself.
  const readInnerHtml = (el: Element): string => (getter ? getter.call(el) : '')
  measureRoot = () => rootHtmlLengthOf(vditor, readInnerHtml)
  if (!windowsInstalled.has(win)) {
    windowsInstalled.add(win)
    installPrototypeWrappers(win)
    installSelectionWrappers(win)
    installVscodeWrapper(win)
  }
  if (!instancesInstalled.has(vditor)) {
    instancesInstalled.add(vditor)
    installInstanceWrappers(win, vditor)
  }
}

function countPost(counters: EditCounters, message: any): void {
  const command = message?.command
  if (command === 'history-delta') counters.historyDeltaPosts++
  if (command !== 'edit' && command !== 'edit-delta') return
  if (command === 'edit') counters.legacyEditPosts++
  else counters.deltaPosts++
  const bytes = JSON.stringify(message).length
  if (bytes > counters.maxPostBytes) counters.maxPostBytes = bytes
}

// Task 733 / 012-11: a whole top-level fenced code block serialized by Lute (its text path makes none).
const CODE_BLOCK_START = '<div data-block="0" data-type="code-block"'

function classify(
  counters: EditCounters,
  input: string,
  isHtml: boolean,
  method: string,
): void {
  const reference = isHtml ? rootHtmlLength : markdownLength
  if (input.length > reference / 2) counters.luteDocument++
  if (input.startsWith('<table') && (input.match(/<tr/g)?.length ?? 0) >= 3)
    counters.luteTable++
  if (
    (input.startsWith('<ul') || input.startsWith('<ol')) &&
    (input.match(/<li/g)?.length ?? 0) >= 3
  )
    counters.luteList++
  if (method === 'VditorIRDOM2Md' && input.startsWith(CODE_BLOCK_START))
    counters.luteBlock++
}

export function installEditCounters(win: Window, vditor: VditorLike): void {
  if (!win.__vmdeEditCounters) {
    const counters = { reset: undefined as unknown } as any
    for (const field of NUMBER_FIELDS) counters[field] = 0
    counters.reset = (length: number) => {
      rootHtmlLength = measureRoot()
      markdownLength = length
      for (const field of NUMBER_FIELDS) counters[field] = 0
    }
    win.__vmdeEditCounters = counters as EditCounters
  }
  install(win, vditor)
}

export function countFallbackPublication(win: Window): void {
  const counters = win.__vmdeEditCounters
  if (counters) counters.fallbackPublications++
}
