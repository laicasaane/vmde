// @probe — measurement only, asserts nothing beyond setup (task 449 convention).
//
// Where does the caret land after a real Ctrl+V in IR mode, how often is that not the end of the
// pasted text, and which code moves it? The reported case is a paste with the caret inside an
// inline code span inside a GFM table cell, so that case runs first and most often.
//
// Every run opens a fresh document, places the caret through the marked selection writer
// (`window.__vmdeWriteSelection`, which retires any live caret intent the way a click does), puts
// the text on the VS Code clipboard and presses Ctrl+V through XTEST (helpers/xtest-input.ts), so
// VS Code's own webview clipboard bridge delivers the paste. An in-page tracer then samples the
// caret at the end of the paste task, after each of 10 animation frames and at 50/150/300/800/
// 1500 ms, and logs every selection write after the paste with its stack: Selection and live-Range
// methods, plus the caret-authority bridges. After the samples one ASCII key is typed and the host
// document shows where it landed. The tracer is removed before the next run.
//
// Output: one JSON file per test under tmp/paste/out/. Stacks are raw bundle positions; map them
// with a source-map tool against media/dist/main.js.map.
//
// Knobs: PASTE_PROBE_REPEAT_PRIMARY (default 15), PASTE_PROBE_REPEAT (default 8),
// PASTE_PROBE_CASES (comma-separated case-name substrings; default all).
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput, type XtestInput } from './helpers/xtest-input'
import { docText, waitForInitialUndoSnapshot, wf } from './webview-helpers'

type Frame = ReturnType<typeof wf>
type Host = (fn: unknown, args: [string] | [string, string]) => Promise<unknown>

const OUT = path.join(__dirname, '..', '..', 'tmp', 'paste', 'out')
const DOCS = path.join(__dirname, '..', '..', 'tmp', 'paste', 'docs')
const REPEAT_PRIMARY = Number(process.env.PASTE_PROBE_REPEAT_PRIMARY ?? 15)
const REPEAT = Number(process.env.PASTE_PROBE_REPEAT ?? 8)
const FILTER = (process.env.PASTE_PROBE_CASES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const TYPED = 'Q'

const TABLE_DOC =
  '# Table probe\n\n| Name | Value `hcode text` |\n| --- | --- |\n| row `alpha beta` | other |\n| `gamma delta` more | cell |\n\nAfter table paragraph.\n'
const PROSE_DOC =
  '# Probe\n\nAlpha bravo charlie delta echo.\n\nGolf **hotel india** juliet.\n\n- kilo one\n- lima two\n- mike three\n\nLast paragraph november.\n'

interface Clip {
  name: string
  text: string
  // Single-line clips are expected inline: the caret sits after the clip, before the target's
  // following text. Multi-block clips are expected after their last visible text (`tail`).
  inline: boolean
  tail: string
}
const CLIPS: Record<string, Clip> = {
  word: { name: 'word', text: 'Pastel', inline: true, tail: 'Pastel' },
  spaces: {
    name: 'spaces',
    text: 'two words here',
    inline: true,
    tail: 'here',
  },
  pipe: { name: 'pipe', text: 'x|y`z tail', inline: true, tail: 'tail' },
  rich: {
    name: 'rich',
    text: 'line with **bold** and `code` end',
    inline: true,
    tail: 'end',
  },
  paras: {
    name: 'paras',
    text: 'para one\n\npara two',
    inline: false,
    tail: 'para two',
  },
  list: {
    name: 'list',
    text: '- item one\n- item two\n- item three',
    inline: false,
    tail: 'item three',
  },
  fence: {
    name: 'fence',
    text: '```js\nconst kilo = 1\nconst lima = 2\n```',
    inline: false,
    tail: 'lima = 2',
  },
  table: {
    name: 'table',
    text: '| h1 | h2 |\n| --- | --- |\n| c1 | zulu |',
    inline: false,
    tail: 'zulu',
  },
}

interface Target {
  name: string
  doc: string
  // Caret placement: a text node under `scope` that contains `needle`, at `needle` offset `k`;
  // or, with `afterNode`, the element boundary just after `scope`'s closest `afterNode`.
  scope: string
  needle?: string
  k?: number
  afterNode?: string
  // Visible text just before and after the caret before the paste (block-relative, ZWSP removed).
  before: string
  after: string
  settle: boolean // wait for the initial undo snapshot before acting
  typeFirst?: string // ASCII typed through XTEST right before the paste
  enterFirst?: boolean // XTEST Return right before the paste (makes an empty paragraph)
  // Place by a real pointer click at the scope's centre instead of a marked selection write; the
  // expectation is then taken from where the click put the caret. The click goes through XTEST
  // (xdotool on the verified VS Code client), not through Playwright's CDP mouse.
  clickOnly?: boolean
  pauseBeforePaste?: number // ms between the placement (or typing) and Ctrl+V; default 0 or 250
}

const TABLE_TARGETS: Target[] = [
  {
    name: 'body-code-mid',
    doc: TABLE_DOC,
    scope: 'tbody tr:nth-of-type(1) td:nth-of-type(1) code',
    needle: 'alpha beta',
    k: 5,
    before: 'alpha',
    after: ' beta`',
    settle: true,
  },
  {
    name: 'body-code-end',
    doc: TABLE_DOC,
    scope: 'tbody tr:nth-of-type(1) td:nth-of-type(1) code',
    needle: 'alpha beta',
    k: 10,
    before: 'alpha beta',
    after: '`',
    settle: true,
  },
  {
    name: 'head-code-mid',
    doc: TABLE_DOC,
    scope: 'thead th:nth-of-type(2) code',
    needle: 'hcode text',
    k: 5,
    before: 'hcode',
    after: ' text`',
    settle: true,
  },
  {
    name: 'body-code-notlast-mid',
    doc: TABLE_DOC,
    scope: 'tbody tr:nth-of-type(2) td:nth-of-type(1) code',
    needle: 'gamma delta',
    k: 5,
    before: 'gamma',
    after: ' delta`',
    settle: true,
  },
  {
    name: 'after-tick-last',
    doc: TABLE_DOC,
    scope: 'tbody tr:nth-of-type(1) td:nth-of-type(1) code',
    afterNode: '.vditor-ir__node',
    before: 'alpha beta`',
    after: '',
    settle: true,
  },
  {
    name: 'after-tick-text',
    doc: TABLE_DOC,
    scope: 'tbody tr:nth-of-type(2) td:nth-of-type(1)',
    needle: ' more',
    k: 0,
    before: 'delta`',
    after: ' more',
    settle: true,
  },
]
// Closer to a person's sequence: a real click, typing just before the paste, a paste soon after
// open. Each changes which undo checkpoints and caret intents exist when the paste arrives.
const TABLE_GESTURE_TARGETS: Target[] = [
  {
    name: 'body-code-click',
    doc: TABLE_DOC,
    scope: 'tbody tr:nth-of-type(1) td:nth-of-type(1) code',
    before: '',
    after: '',
    settle: true,
    clickOnly: true,
  },
  {
    name: 'body-code-click-fast',
    doc: TABLE_DOC,
    scope: 'tbody tr:nth-of-type(1) td:nth-of-type(1) code',
    before: '',
    after: '',
    settle: true,
    clickOnly: true,
    pauseBeforePaste: 0,
  },
  {
    name: 'body-code-click-early',
    doc: TABLE_DOC,
    scope: 'tbody tr:nth-of-type(1) td:nth-of-type(1) code',
    before: '',
    after: '',
    settle: false,
    clickOnly: true,
  },
  {
    name: 'body-code-typed',
    doc: TABLE_DOC,
    scope: 'tbody tr:nth-of-type(1) td:nth-of-type(1) code',
    needle: 'alpha beta',
    k: 5,
    before: 'alphaxy',
    after: ' beta`',
    settle: true,
    typeFirst: 'xy',
  },
  {
    name: 'body-code-typed-pause',
    doc: TABLE_DOC,
    scope: 'tbody tr:nth-of-type(1) td:nth-of-type(1) code',
    needle: 'alpha beta',
    k: 5,
    before: 'alphaxy',
    after: ' beta`',
    settle: true,
    typeFirst: 'xy',
    pauseBeforePaste: 400,
  },
  // Typing 1-3 keys at several delays before Ctrl+V: inside, near and beyond the undo
  // checkpoint window (Undo delay 800 ms + 50 ms) that decides whether boundary() takes a
  // pre-paste checkpoint.
  ...(
    [
      ['x', 50],
      ['xyz', 300],
      ['xy', 700],
      ['xy', 1200],
    ] as const
  ).map(
    ([keys, ms]): Target => ({
      name: `body-code-typed-${keys.length}k-${ms}ms`,
      doc: TABLE_DOC,
      scope: 'tbody tr:nth-of-type(1) td:nth-of-type(1) code',
      needle: 'alpha beta',
      k: 5,
      before: `alpha${keys}`,
      after: ' beta`',
      settle: true,
      typeFirst: keys,
      pauseBeforePaste: ms,
    }),
  ),
  // A person's full sequence: real click into the code, two keys, Ctrl+V soon after.
  {
    name: 'body-code-click-typed',
    doc: TABLE_DOC,
    scope: 'tbody tr:nth-of-type(1) td:nth-of-type(1) code',
    before: '',
    after: '',
    settle: true,
    clickOnly: true,
    typeFirst: 'xy',
    pauseBeforePaste: 150,
  },
  {
    name: 'body-code-first-action',
    doc: TABLE_DOC,
    scope: 'tbody tr:nth-of-type(1) td:nth-of-type(1) code',
    needle: 'alpha beta',
    k: 5,
    before: 'alpha',
    after: ' beta`',
    settle: false,
  },
]

const PROSE_TARGETS: Target[] = [
  {
    name: 'para-mid',
    doc: PROSE_DOC,
    scope: 'p',
    needle: 'Alpha bravo charlie',
    k: 11,
    before: 'bravo',
    after: ' charlie',
    settle: true,
  },
  {
    name: 'para-end',
    doc: PROSE_DOC,
    scope: 'p',
    needle: 'delta echo.',
    k: 11,
    before: 'echo.',
    after: '',
    settle: true,
  },
  {
    name: 'bold-mid',
    doc: PROSE_DOC,
    scope: 'strong',
    needle: 'hotel india',
    k: 5,
    before: 'hotel',
    after: ' india**',
    settle: true,
  },
  {
    name: 'list-mid',
    doc: PROSE_DOC,
    scope: 'li',
    needle: 'lima two',
    k: 4,
    before: 'lima',
    after: ' two',
    settle: true,
  },
  {
    name: 'blank-line',
    doc: PROSE_DOC,
    scope: 'p',
    needle: 'delta echo.',
    k: 11,
    before: '',
    after: '',
    settle: true,
    enterFirst: true,
  },
  {
    name: 'first-action',
    doc: PROSE_DOC,
    scope: 'p',
    needle: 'Alpha bravo charlie',
    k: 11,
    before: 'bravo',
    after: ' charlie',
    settle: false,
  },
  {
    name: 'after-typing',
    doc: PROSE_DOC,
    scope: 'p',
    needle: 'Alpha bravo charlie',
    k: 11,
    before: 'bravoxy',
    after: ' charlie',
    settle: true,
    typeFirst: 'xy',
  },
]

interface Expect {
  before: string
  after: string
}
function expectation(target: Target, clip: Clip): Expect {
  if (clip.inline)
    return { before: target.before + clip.text, after: target.after }
  return { before: clip.tail, after: '' }
}

const selected = (name: string) =>
  FILTER.length === 0 || FILTER.some((f) => name.includes(f))

let docCount = 0

async function openDoc(
  host: Host,
  workbox: import('@playwright/test').Page,
  body: string,
) {
  mkdirSync(DOCS, { recursive: true })
  const file = path.join(DOCS, `${process.pid}-${docCount++}.md`)
  writeFileSync(file, body)
  await host(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    },
    [''],
  )
  await host(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  const marker = body.includes('Table probe') ? 'gamma delta' : 'lima two'
  await expect
    .poll(() => frame.locator('.vditor-ir').first().innerText(), {
      timeout: 20_000,
    })
    .toContain(marker)
  return { file, frame }
}

const writeClip = (host: Host, text: string) =>
  host(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.env.clipboard.writeText(args[0])
    },
    [text],
  )

/** Installs the in-page tracer as `window.__pp`. Self-contained: serialized into the webview. */
function installTracer(
  _el: unknown,
  expected: { before: string; after: string },
) {
  const w = window as any
  const rootOf = (): HTMLElement => w.vditor.vditor.ir.element
  Error.stackTraceLimit = 40
  const strip = (s: string) => s.replace(/\u200b/g, '')
  const pp: any = {
    pasteAt: null as number | null,
    installAt: performance.now(),
    armed: true,
    done: false,
    samples: [] as unknown[],
    writes: [] as unknown[],
    changes: [] as unknown[],
    mutations: [] as unknown[],
    errors: [] as unknown[],
    restore: [] as (() => void)[],
    expected,
  }
  w.__pp = pp
  // Milliseconds since the paste event; before it, negative milliseconds until the paste (fixed up
  // when the paste arrives, see onPaste).
  const now = () =>
    Math.round((performance.now() - (pp.pasteAt ?? pp.installAt)) * 10) / 10

  const elDesc = (e: Element) => {
    const cls =
      typeof e.className === 'string' && e.className
        ? `.${e.className.split(/\s+/)[0]}`
        : ''
    const dt = e.getAttribute('data-type')
    return `${e.tagName.toLowerCase()}${cls}${dt ? `[${dt}]` : ''}`
  }
  const desc = (n: Node | null | undefined): string => {
    if (!n) return 'null'
    const root = rootOf()
    const parts: string[] = []
    let cur: Node | null = n
    while (cur && cur !== root && parts.length < 8) {
      parts.unshift(
        cur.nodeType === 3
          ? `#text${JSON.stringify(strip(cur.textContent ?? '').slice(0, 24))}`
          : elDesc(cur as Element),
      )
      cur = cur.parentNode
    }
    if (cur !== root) parts.unshift(n.isConnected ? 'OUTSIDE' : 'DETACHED')
    return parts.join('>')
  }
  const caret = () => {
    const sel = getSelection()
    if (!sel?.rangeCount) return { node: 'none' }
    const n = sel.focusNode as Node
    const o = sel.focusOffset
    const root = rootOf()
    const host = n.nodeType === 3 ? n.parentElement : (n as Element)
    const block =
      host?.closest('td,th,li,p,h1,h2,h3,h4,h5,h6,pre,blockquote') ?? null
    let before = ''
    let after = ''
    let ok = false
    let delta: number | null = null
    let blockDesc = 'none'
    if (block && root.contains(block)) {
      const r = document.createRange()
      r.selectNodeContents(block)
      r.setEnd(n, o)
      before = strip(r.toString())
      const full = strip(block.textContent ?? '')
      after = full.slice(before.length, before.length + 14)
      const exp = pp.expected as { before: string; after: string }
      ok = before.endsWith(exp.before) && after.startsWith(exp.after)
      const at = full.indexOf(exp.before + exp.after)
      if (at >= 0) delta = before.length - (at + exp.before.length)
      blockDesc = `${elDesc(block)}"${full.slice(0, 16)}"`
    }
    return {
      anchor:
        sel.anchorNode === n
          ? undefined
          : `${desc(sel.anchorNode)}:${sel.anchorOffset}`,
      node: desc(n),
      offset: o,
      collapsed: sel.isCollapsed,
      block: blockDesc,
      before: before.slice(-26),
      after,
      ok,
      delta,
    }
  }
  const sample = (label: string) =>
    pp.samples.push({ label, t: now(), ...caret() })
  const stack = () =>
    (new Error().stack ?? '')
      .split('\n')
      .slice(3)
      .map((l) => l.trim())
  const argDesc = (a: unknown[]) =>
    a.map((x) =>
      x instanceof Node
        ? desc(x)
        : x instanceof Range
          ? `Range(${desc(x.startContainer)}:${x.startOffset})`
          : JSON.stringify(x),
    )
  const log = (what: string, args: unknown[]) => {
    if (!pp.armed || pp.writes.length > 800) return
    pp.writes.push({
      t: now(),
      what,
      args: argDesc(args),
      caret: caret(),
      stack: stack(),
    })
  }
  const liveRange = () => {
    const s = getSelection()
    return s?.rangeCount ? s.getRangeAt(0) : null
  }
  const wrap = (proto: any, name: string, kind: string, live: boolean) => {
    const orig = proto[name]
    if (typeof orig !== 'function') return
    proto[name] = function (this: unknown, ...a: unknown[]) {
      const isLive = !live || this === liveRange()
      const r = orig.apply(this, a)
      if (isLive) log(`${kind}.${name}`, a)
      return r
    }
    pp.restore.push(() => {
      proto[name] = orig
    })
  }
  for (const m of [
    'collapse',
    'setPosition',
    'setBaseAndExtent',
    'addRange',
    'removeAllRanges',
    'removeRange',
    'extend',
    'collapseToStart',
    'collapseToEnd',
    'selectAllChildren',
    'modify',
    'empty',
  ])
    wrap(Selection.prototype, m, 'Selection', false)
  for (const m of [
    'setStart',
    'setEnd',
    'setStartBefore',
    'setStartAfter',
    'setEndBefore',
    'setEndAfter',
    'collapse',
    'selectNode',
    'selectNodeContents',
  ])
    wrap(Range.prototype, m, 'LiveRange', true)
  const bridge = (name: string) => {
    const orig = w[name]
    if (typeof orig !== 'function') return
    w[name] = (...a: unknown[]) => {
      const intent = a[0] as any
      const shown =
        intent && typeof intent === 'object'
          ? Object.fromEntries(
              Object.entries(intent).map(([k, v]) => [
                k,
                v instanceof Node ? desc(v) : v instanceof Range ? 'Range' : v,
              ]),
            )
          : intent
      log(`bridge.${name}`, [shown])
      return orig(...a)
    }
    pp.restore.push(() => {
      w[name] = orig
    })
  }
  for (const b of [
    '__vmdeRequestCaret',
    '__vmdeWriteSelection',
    '__vmdeRestoreUndoSnapshotCaret',
    '__vmdeUndoRestoreCaret',
  ])
    bridge(b)
  const onChange = () => {
    if (pp.armed && pp.changes.length < 400)
      pp.changes.push({ t: now(), ...caret() })
  }
  const onError = (e: ErrorEvent) =>
    pp.errors.push({
      t: now(),
      kind: 'error',
      message: String(e.message),
      stack: String(e.error?.stack ?? '')
        .split('\n')
        .slice(0, 12),
    })
  const onRejection = (e: PromiseRejectionEvent) =>
    pp.errors.push({
      t: now(),
      kind: 'rejection',
      message: String(e.reason?.message ?? e.reason),
      stack: String(e.reason?.stack ?? '')
        .split('\n')
        .slice(0, 12),
    })
  const observer = new MutationObserver((records) => {
    if (!pp.armed || pp.mutations.length > 300) return
    const targets = [...new Set(records.map((r) => desc(r.target)))].slice(0, 3)
    pp.mutations.push({ t: now(), n: records.length, targets })
  })
  observer.observe(rootOf(), {
    subtree: true,
    childList: true,
    characterData: true,
  })
  const onPaste = (event: ClipboardEvent) => {
    if (pp.pasteAt !== null) return
    pp.pasteAt = performance.now()
    const shift = pp.pasteAt - pp.installAt
    for (const list of [pp.writes, pp.changes, pp.mutations, pp.errors])
      for (const e of list) e.t = Math.round((e.t - shift) * 10) / 10
    pp.pasteTarget = desc(event.target as Node)
    pp.pasteTypes = [...(event.clipboardData?.types ?? [])]
    sample('event')
    queueMicrotask(() => sample('microtask'))
    setTimeout(() => sample('timeout0'), 0)
    let f = 0
    const frame = () => {
      f++
      sample(`raf${f}`)
      if (f < 10) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    for (const ms of [50, 150, 300, 800, 1500])
      setTimeout(() => {
        sample(`${ms}ms`)
        if (ms === 1500) pp.done = true
      }, ms)
  }
  window.addEventListener('paste', onPaste, true)
  document.addEventListener('selectionchange', onChange)
  window.addEventListener('error', onError, true)
  window.addEventListener('unhandledrejection', onRejection)
  pp.strip = () => {
    for (const r of pp.restore) r()
    observer.disconnect()
    window.removeEventListener('paste', onPaste, true)
    document.removeEventListener('selectionchange', onChange)
    window.removeEventListener('error', onError, true)
    window.removeEventListener('unhandledrejection', onRejection)
    pp.armed = false
  }
  pp.caret = caret
}

// A real left click through XTEST at a workbox-viewport point (DPR 1), on the same verified X11
// client that receives the XTEST keys. Set by runMatrix.
let xtestClick: ((point: { x: number; y: number }) => Promise<void>) | null =
  null

async function place(frame: Frame, target: Target) {
  const scope = frame
    .locator('.vditor-ir .vditor-reset')
    .first()
    .locator(target.scope)
    .first()
  if (target.clickOnly) {
    const box = await scope.boundingBox()
    if (!box || !xtestClick)
      throw new Error(`no XTEST click for ${target.name}`)
    await xtestClick({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
    await settleMs(frame, 60)
    return frame.locator('body').evaluate(() => (window as any).__pp.caret())
  }
  await scope.click()
  return frame.locator('body').evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: serialized in-page placement (text-node walk or element boundary) must stay self-contained
    (_el, t) => {
      const w = window as any
      const root: HTMLElement = w.vditor.vditor.ir.element
      const scopes = [...root.querySelectorAll(t.scope)]
      const range = document.createRange()
      let found = false
      for (const scope of scopes) {
        if (t.afterNode) {
          const node = scope.closest(t.afterNode)
          if (!node) continue
          range.setStartAfter(node)
          found = true
          break
        }
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const i = (n.textContent ?? '').indexOf(t.needle as string)
          if (i < 0) continue
          range.setStart(n, i + (t.k as number))
          found = true
          break
        }
        if (found) break
      }
      if (!found) throw new Error(`placement ${t.name} not found`)
      range.collapse(true)
      root.focus({ preventScroll: true })
      w.__vmdeWriteSelection(range)
      return w.__pp.caret()
    },
    target,
  )
}

const settleMs = (frame: Frame, ms: number) =>
  frame
    .locator('body')
    .evaluate((_el, d) => new Promise((r) => setTimeout(r, d as number)), ms)

// Waits for the tracer to see the paste event and finish its 1500 ms samples. False: no paste
// event arrived (the key never reached the webview), recorded as undelivered.
async function waitForPaste(frame: Frame): Promise<boolean> {
  const flag = (name: 'pasted' | 'done', timeout: number) =>
    expect
      .poll(
        () =>
          frame.locator('body').evaluate((_el, n) => {
            const pp = (window as any).__pp
            return n === 'pasted' ? pp?.pasteAt !== null : pp?.done === true
          }, name),
        { timeout },
      )
      .toBe(true)
  try {
    await flag('pasted', 4000)
    await flag('done', 6000)
    return true
  } catch {
    return false
  }
}

// Types one ASCII key and reports where it landed in the host document.
async function typeAndLocate(
  host: Host,
  xtest: XtestInput,
  file: string,
  exp: Expect,
) {
  await xtest.type(TYPED)
  const read = () => docText(host as never, file)
  await expect
    .poll(async () => (await read()).includes(TYPED), { timeout: 4000 })
    .toBe(true)
    .catch(() => undefined)
  const flat = (await read()).replace(/\u200b/g, '')
  const at = flat.indexOf(TYPED)
  const lastWord = (
    exp.before.match(/[A-Za-z0-9 =]+$/)?.[0] ?? exp.before
  ).slice(-8)
  return {
    ok: flat.includes(lastWord + TYPED + exp.after.slice(0, 6)),
    context: at >= 0 ? flat.slice(Math.max(0, at - 18), at + 14) : null,
    md: flat,
  }
}

// One run: fresh document, tracer, placement, Ctrl+V, samples, one typed key, tracer removed.
async function oneRun(
  host: Host,
  workbox: import('@playwright/test').Page,
  xtest: XtestInput,
  target: Target,
  clip: Clip,
  index: number,
) {
  const exp = expectation(target, clip)
  const { file, frame } = await openDoc(host, workbox, target.doc)
  if (target.settle) {
    await waitForInitialUndoSnapshot(frame)
    await settleMs(frame, 300)
  }
  await frame.locator('body').evaluate(installTracer, exp)
  await writeClip(host, clip.text)
  let placed = await place(frame, target)
  if (target.clickOnly) {
    // The click decides the position: expect the clip right there, between the 5 visible
    // characters before and after the clicked caret.
    if (clip.inline) {
      exp.before =
        placed.before.slice(-5) + (target.typeFirst ?? '') + clip.text
      exp.after = placed.after.slice(0, 5)
    }
    placed = await frame.locator('body').evaluate((_el, e) => {
      const pp = (window as any).__pp
      pp.expected = e
      return pp.caret()
    }, exp)
  }
  const pause = target.pauseBeforePaste ?? (target.settle ? 250 : 0)
  if (!target.typeFirst && pause) await settleMs(frame, pause)
  if (target.enterFirst) {
    await xtest.key('Return')
    await settleMs(frame, 400)
  }
  if (target.typeFirst) {
    await xtest.type(target.typeFirst)
    if (target.pauseBeforePaste) await settleMs(frame, target.pauseBeforePaste)
  }
  const tKey = Date.now()
  await xtest.key('ctrl+v')
  const delivered = await waitForPaste(frame)
  const keyToPaste = Date.now() - tKey
  const mdAfterPaste = await docText(host as never, file)
  const typed = delivered ? await typeAndLocate(host, xtest, file, exp) : null
  const trace = await frame.locator('body').evaluate(() => {
    const pp = (window as any).__pp
    if (!pp) return null
    pp.strip()
    const {
      pasteAt,
      pasteTarget,
      pasteTypes,
      samples,
      writes,
      changes,
      mutations,
      errors,
    } = pp
    delete (window as any).__pp
    return {
      pasteAt,
      pasteTarget,
      pasteTypes,
      samples,
      writes,
      changes,
      mutations,
      errors,
    }
  })
  rmSync(file, { force: true })
  return {
    target: target.name,
    clip: clip.name,
    index,
    expected: exp,
    placed,
    delivered,
    keyToPasteMs: keyToPaste,
    mdAfterPaste,
    typed,
    trace,
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: probe tally over optional per-run fields; flat on purpose so the counting rules read in one place
function summarize(runs: Awaited<ReturnType<typeof oneRun>>[]) {
  const by = new Map<
    string,
    {
      n: number
      finalOk: number
      typedOk: number
      undelivered: number
      finals: Record<string, number>
      firstWrong: Record<string, number>
    }
  >()
  for (const r of runs) {
    const key = `${r.target}/${r.clip}`
    const e = by.get(key) ?? {
      n: 0,
      finalOk: 0,
      typedOk: 0,
      undelivered: 0,
      finals: {},
      firstWrong: {},
    }
    e.n++
    if (!r.delivered) e.undelivered++
    const samples = (r.trace?.samples ?? []) as {
      label: string
      ok: boolean
      before: string
      after: string
      delta: number | null
    }[]
    const last = samples.at(-1)
    if (last?.ok) e.finalOk++
    if ((r.typed as { ok?: boolean } | null)?.ok) e.typedOk++
    const shape = last
      ? `${last.ok ? 'OK' : 'WRONG'} d=${last.delta} …${last.before.slice(-10)}|${last.after.slice(0, 6)}`
      : 'none'
    e.finals[shape] = (e.finals[shape] ?? 0) + 1
    const firstBad = samples.find((s, i) => i > 0 && !s.ok)
    const fw = firstBad ? firstBad.label : 'never'
    e.firstWrong[fw] = (e.firstWrong[fw] ?? 0) + 1
    by.set(key, e)
  }
  return Object.fromEntries(by)
}

async function runMatrix(
  name: string,
  cases: { target: Target; clip: Clip; repeat: number }[],
  fixtures: {
    workbox: import('@playwright/test').Page
    electronApp: import('@playwright/test').ElectronApplication
    evaluateInVSCode: unknown
  },
) {
  const host = fixtures.evaluateInVSCode as Host
  await host(
    async (vscode: typeof import('vscode')) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    },
    [''],
  )
  const xtest = await createXtestInput(
    fixtures.electronApp as never,
    fixtures.workbox as never,
  )
  const nativeWindow = await fixtures.electronApp.browserWindow(
    fixtures.workbox,
  )
  xtestClick = async (point) => {
    await xtest.activateAndFocus()
    const bounds = await nativeWindow.evaluate((w) => w.getContentBounds())
    const xdotool = (args: string[]) =>
      execFileSync('/usr/bin/xdotool', args, { timeout: 5000 })
    // One xdotool process for move and click, without `--sync`: `mousemove --sync` waits for
    // pointer motion and never returns when the pointer already sits at the point (the second
    // repeat of the same target).
    xdotool([
      'mousemove',
      String(Math.round(bounds.x + point.x)),
      String(Math.round(bounds.y + point.y)),
      'click',
      '1',
    ])
  }
  mkdirSync(OUT, { recursive: true })
  // Warm-up: the first XTEST Ctrl chord of a session sometimes never reaches the webview (Task 598).
  const warm = await openDoc(host, fixtures.workbox, PROSE_DOC)
  await waitForInitialUndoSnapshot(warm.frame)
  await warm.frame.locator('.vditor-ir .vditor-reset p').first().click()
  await xtest.key('ctrl+z')
  await settleMs(warm.frame, 300)
  rmSync(warm.file, { force: true })
  const runs: Awaited<ReturnType<typeof oneRun>>[] = []
  const outFile = path.join(OUT, `${name}.json`)
  for (const c of cases) {
    for (let i = 0; i < c.repeat; i++) {
      try {
        runs.push(
          await oneRun(host, fixtures.workbox, xtest, c.target, c.clip, i),
        )
      } catch (error) {
        runs.push({
          target: c.target.name,
          clip: c.clip.name,
          index: i,
          failure: String(error),
        } as never)
      }
    }
    writeFileSync(
      outFile,
      JSON.stringify(
        { name, summary: summarize(runs.filter((r) => 'trace' in r)), runs },
        null,
        1,
      ),
    )
    console.log(
      `[paste-probe ${name}] ${c.target.name}/${c.clip.name}`,
      JSON.stringify(
        summarize(
          runs.filter(
            (r) =>
              r.target === c.target.name &&
              r.clip === c.clip.name &&
              'trace' in r,
          ),
        ),
      ),
    )
  }
  return runs
}

const PRIMARY_CLIPS = [CLIPS.word, CLIPS.spaces, CLIPS.pipe]
const MATRIX_CLIPS = [
  CLIPS.word,
  CLIPS.rich,
  CLIPS.paras,
  CLIPS.list,
  CLIPS.fence,
  CLIPS.table,
]

test('@probe IR paste caret: inline code in a table cell', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
}) => {
  test.setTimeout(58 * 60_000)
  const cases = TABLE_TARGETS.flatMap((target) =>
    PRIMARY_CLIPS.map((clip) => ({
      target,
      clip,
      repeat:
        target.name.startsWith('body-code-mid') ||
        target.name === 'body-code-end'
          ? REPEAT_PRIMARY
          : REPEAT,
    })),
  ).filter((c) => selected(`${c.target.name}/${c.clip.name}`))
  await runMatrix('primary', cases, { workbox, electronApp, evaluateInVSCode })
})

test('@probe IR paste caret: table gestures', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
}) => {
  test.setTimeout(58 * 60_000)
  const cases = TABLE_GESTURE_TARGETS.flatMap((target) =>
    [CLIPS.word, CLIPS.spaces].map((clip) => ({
      target,
      clip,
      repeat: REPEAT,
    })),
  ).filter((c) => selected(`${c.target.name}/${c.clip.name}`))
  await runMatrix('primary-b', cases, {
    workbox,
    electronApp,
    evaluateInVSCode,
  })
})

for (const [part, names] of [
  ['matrix-a', ['para-mid', 'para-end', 'bold-mid', 'list-mid']],
  ['matrix-b', ['blank-line', 'first-action', 'after-typing']],
] as const) {
  test(`@probe IR paste caret: ${part}`, async ({
    workbox,
    electronApp,
    evaluateInVSCode,
  }) => {
    test.setTimeout(58 * 60_000)
    const cases = PROSE_TARGETS.filter((t) =>
      (names as readonly string[]).includes(t.name),
    )
      .flatMap((target) =>
        MATRIX_CLIPS.map((clip) => ({ target, clip, repeat: REPEAT })),
      )
      .filter((c) => selected(`${c.target.name}/${c.clip.name}`))
    await runMatrix(part, cases, { workbox, electronApp, evaluateInVSCode })
  })
}
