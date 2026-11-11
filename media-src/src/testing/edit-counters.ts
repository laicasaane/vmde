// Task 733 — edit-path counters for end-to-end runs only. finish-init installs them when
// `window.__vmdeE2EReadiness` exists; in a product page nothing here runs, so no global is created
// and no prototype is wrapped. Every wrapper forwards `this` and the arguments to the original and
// returns its result unchanged; it only increments counters.

export interface EditCounters {
  fullGetValue: number
  luteDocument: number
  luteTable: number
  luteList: number
  rootClone: number
  rootInnerHtmlRead: number
  legacyEditPosts: number
  deltaPosts: number
  maxPostBytes: number
  fallbackPublications: number
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
  'rootClone',
  'rootInnerHtmlRead',
  'legacyEditPosts',
  'deltaPosts',
  'maxPostBytes',
  'fallbackPublications',
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

/** Prototype wrappers: deep clones of a mode root and `innerHTML` reads on a root or its clone. */
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
    return clone
  } as typeof proto.cloneNode

  const elementProto = view.Element.prototype
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
        classify(win.__vmdeEditCounters!, input, isHtml)
      return original.call(this, input, ...rest)
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
    installVscodeWrapper(win)
  }
  if (!instancesInstalled.has(vditor)) {
    instancesInstalled.add(vditor)
    installInstanceWrappers(win, vditor)
  }
}

function countPost(counters: EditCounters, message: any): void {
  const command = message?.command
  if (command !== 'edit' && command !== 'edit-delta') return
  if (command === 'edit') counters.legacyEditPosts++
  else counters.deltaPosts++
  const bytes = JSON.stringify(message).length
  if (bytes > counters.maxPostBytes) counters.maxPostBytes = bytes
}

function classify(
  counters: EditCounters,
  input: string,
  isHtml: boolean,
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
