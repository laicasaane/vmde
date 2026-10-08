/**
 * PROBE (Tasks 625 + 627) — measures where the caret and the next typed key go after Enter at a
 * paragraph end (Task 625: IR, first character lands in a neighbouring block) and at the end of the
 * document (Task 627: no new paragraph to type in), in the real VS Code webview. NOT a regression
 * net: it asserts only harness preconditions (exact open bytes, keys delivered) and prints one
 * `[Task 625/627 enter]` JSON line per case plus a JSON attachment.
 *
 * Hypotheses it separates. H1: Enter creates an empty `<p>` without a line box (VMDE's
 * `white-space: normal` on `p` collapses upstream's `p:empty::before` space), so Chromium
 * canonicalizes the caret into a neighbouring block. H2: a VMDE writer moves the selection between
 * Enter and the key. The discriminator is the `beforeinput` record: the selection against the
 * event's target range, with a log of Selection writes after Enter. The CSS-control cells add a
 * stylesheet that gives the empty `<p>` a line box before Enter.
 *
 * Read-only in-page wrappers record trusted keys, `beforeinput`/`input`, `selectionchange`, Selection
 * method calls and Vditor's undo entries; a host listener records document versions and texts.
 * Fixtures are synthetic, so exact texts are printed.
 *
 * @probe — excluded from the default run; run with
 * `VMDE_XTEST=1 npm --prefix test/vscode-e2e run test:probes -- enter-new-paragraph-probe.spec.ts`
 * inside the isolated Xvfb/Openbox shell of docs/os-keyboard-testing-setup.md.
 */
import { createHash } from 'node:crypto'
import { expect, test } from 'vscode-test-playwright'
import {
  type Ctx,
  closeAll,
  evalFrame,
  firstLine,
  type Kit,
  type Mode,
  makeKit,
  openDocument,
  select,
} from './helpers/shortcut-xtest-kit'
import { waitForInitialUndoSnapshot } from './webview-helpers'

const LABEL = 'Task 625/627 enter'
// Task 602's DOC: round-trips exactly through every mode's serializer.
const DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia juliet kilo lima.\n'
const PREFIX = '# Probe\n\nAlpha bravo charlie delta.\n\n'
const LIMA = 'India juliet kilo lima.'
const CODE = '```js\nconst echo = 1\n```'
const TABLE = '| Echo | Golf |\n| --- | --- |\n| foxtrot | hotel |'
// Gives the empty paragraph Enter adds a line box again (upstream's p:empty::before space shows
// under pre-wrap); specificity (0,3,1) beats main.css's `:is(...) .vditor-reset :is(p, li)` (0,2,1).
const CONTROL_CSS =
  ':is(.vditor-ir,.vditor-wysiwyg) .vditor-reset p:empty{white-space:pre-wrap}'

interface Case {
  id: string
  mode: Mode
  content: string
  /** Token whose end holds the caret (route A); null = focus the editor, then Ctrl+End (route B). */
  anchor: string | null
  /** Token that starts the block after the caret block (labels a defect that lands there). */
  next?: string
  /** Exact host text for the expected outcome; null = record only. */
  expected: string | null
  keys?: Keys
  /** The typed character (default Y). */
  ch?: string
  gap?: number
  css?: boolean
  /** Typed (and 100 ms awaited) at the caret before Enter. */
  lead?: string
}

type Keys = 'xtest' | 'cdp' | 'cdp-shift'
type Row = Record<string, unknown>

// --- Page side (serialized into the webview; no outer references) ---

function installProbe(_body: Element, ch: string): boolean {
  const w = window as any
  const inner = w.vditor?.vditor
  if (!inner?.undo) return false
  if (w.__t625) return true
  const undo = inner.undo
  const root = () => inner[inner.currentMode].element as HTMLElement
  const rec: any = {
    keys: [],
    inputs: [],
    snaps: [],
    moves: [],
    muts: [],
    writes: [],
    entries: [],
    engine: 0,
    enterAt: 0,
    ch,
    cur: '',
  }
  w.__t625 = rec
  const topOf = (node: Node | null): number => {
    const r = root()
    if (!node) return -9
    if (node === r) return -1
    let n: Node | null = node
    while (n && n.parentNode !== r) n = n.parentNode
    return n ? Array.prototype.indexOf.call(r.childNodes, n) : -2
  }
  const desc = (node: Node | null, offset: number) =>
    node
      ? {
          top: topOf(node),
          tag: node.nodeType === 3 ? '#text' : node.nodeName.toLowerCase(),
          offset,
          len:
            node.nodeType === 3
              ? (node as Text).data.length
              : node.childNodes.length,
          root: node === root(),
        }
      : null
  const shape = (el: Element) => ({
    tag: el.nodeName.toLowerCase(),
    children: el.childNodes.length,
    kids: Array.from(el.childNodes)
      .slice(0, 4)
      .map((n) => (n.nodeType === 3 ? '#text' : n.nodeName.toLowerCase())),
    textLen: (el.textContent ?? '').length,
    h: Math.round(el.getBoundingClientRect().height * 10) / 10,
    ws: getComputedStyle(el).whiteSpace,
    before: getComputedStyle(el, '::before').content,
    empty: el.matches(':empty'),
  })
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one read-only snapshot of the caret and its neighbouring blocks
  const snap = (label: string) => {
    const r = root()
    const s = getSelection()
    const out: any = {
      label,
      t: Date.now(),
      blocks: r.childNodes.length,
      caret: null,
    }
    rec.snaps.push(out)
    if (!s?.rangeCount) return out
    const c = s.anchorNode as Node
    out.caret = {
      ...desc(c, s.anchorOffset),
      collapsed: s.isCollapsed,
      inBlock: c !== r && r.contains(c),
    }
    const top =
      out.caret.top >= 0 ? out.caret.top : c === r ? s.anchorOffset : -1
    out.window = []
    for (
      let i = Math.max(0, top - 2);
      i <= top + 2 && i < r.childNodes.length;
      i++
    ) {
      const n = r.childNodes[i]
      if (n.nodeType !== 1) {
        out.window.push({
          i,
          tag: '#text',
          textLen: (n.nodeValue ?? '').length,
        })
        continue
      }
      const el = n as HTMLElement
      out.window.push({
        i,
        ...shape(el),
        dataBlock: el.getAttribute('data-block'),
        trailing: el.hasAttribute('data-vmde-trailing'),
        leading: el.hasAttribute('data-vmde-leading'),
        gap: el.hasAttribute('data-vmde-gap'),
      })
    }
    const host = c.nodeType === 1 ? (c as Element) : c.parentElement
    const leaf = host?.closest('p, li, h1, h2, h3, h4, h5, h6, td, th, pre')
    out.leaf = leaf && r.contains(leaf) ? shape(leaf) : null
    const rects = s.getRangeAt(0).getClientRects()
    out.rects = {
      count: rects.length,
      h: rects.length ? Math.round(rects[0].height * 10) / 10 : null,
    }
    return out
  }
  const frames2 = (fn: () => void) =>
    requestAnimationFrame(() => requestAnimationFrame(fn))
  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted) return
      rec.cur = `keydown:${event.key}`
      rec.keys.push({
        key: event.key,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        t: Date.now(),
      })
      if (event.key === 'Enter' && !rec.enterAt) {
        rec.enterAt = Date.now()
        snap('atEnter')
        frames2(() => snap('enter+2raf'))
      } else if (rec.enterAt && !rec.beforeY && event.key === ch) {
        rec.beforeY = true
        snap('beforeY')
      }
    },
    true,
  )
  document.addEventListener(
    'beforeinput',
    (event) => {
      rec.cur = 'beforeinput'
      if (rec.inputs.length >= 40) return
      const e = event as InputEvent
      const s = getSelection()
      const target = e.getTargetRanges?.()[0]
      rec.inputs.push({
        phase: 'beforeinput',
        t: Date.now(),
        type: e.inputType,
        data: e.data,
        cancelable: e.cancelable,
        sel: s?.rangeCount ? desc(s.anchorNode, s.anchorOffset) : null,
        target: target
          ? {
              ...desc(target.startContainer, target.startOffset),
              collapsed: target.collapsed,
            }
          : null,
      })
    },
    true,
  )
  document.addEventListener(
    'input',
    (event) => {
      rec.cur = 'input'
      const e = event as InputEvent
      if (rec.inputs.length < 40)
        rec.inputs.push({
          phase: 'input',
          t: Date.now(),
          type: e.inputType,
          data: e.data,
        })
      if (e.inputType === 'insertParagraph' && !rec.inputSnap) {
        rec.inputSnap = true
        frames2(() => snap('input+2raf'))
      }
    },
    true,
  )
  // Read-only: what changes the DOM after Enter (the CDP and XTEST routes differ in a text node
  // that exists before the key's beforeinput).
  const nodeInfo = (n: Node) =>
    n.nodeType === 3
      ? `#text(${(n as Text).data.length}:${Array.from(
          (n as Text).data.slice(0, 3),
        )
          .map((ch) => ch.codePointAt(0)?.toString(16))
          .join(',')})`
      : n.nodeName.toLowerCase()
  new MutationObserver((records) => {
    if (!rec.enterAt) return
    for (const m of records) {
      if (rec.muts.length >= 40) return
      rec.muts.push({
        t: Date.now(),
        after: rec.cur,
        type: m.type,
        top: topOf(m.target),
        target: nodeInfo(m.target),
        added: Array.from(m.addedNodes).map(nodeInfo),
        removed: Array.from(m.removedNodes).map(nodeInfo),
      })
    }
  }).observe(root(), { childList: true, characterData: true, subtree: true })
  document.addEventListener(
    'keypress',
    (event) => {
      if (!rec.enterAt || !event.isTrusted) return
      rec.cur = 'keypress'
      rec.keys.push({ key: `keypress:${event.key}`, t: Date.now() })
    },
    true,
  )
  let last = ''
  document.addEventListener('selectionchange', () => {
    if (!rec.enterAt || rec.moves.length >= 60) return
    const s = getSelection()
    const d = s?.rangeCount ? desc(s.anchorNode, s.anchorOffset) : null
    const key = JSON.stringify(d)
    if (key === last) return
    last = key
    rec.moves.push({ t: Date.now(), ...d })
  })
  // Pass-through wrappers that log which code writes the selection after Enter (the H2 test).
  const proto = Selection.prototype as any
  for (const name of [
    'addRange',
    'removeAllRanges',
    'setBaseAndExtent',
    'collapse',
    'extend',
  ]) {
    const original = proto[name]
    if (typeof original !== 'function') continue
    proto[name] = function (...args: unknown[]) {
      if (rec.enterAt && rec.writes.length < 40) {
        const range = args[0] instanceof Range ? args[0] : null
        rec.writes.push({
          t: Date.now(),
          fn: name,
          to: range ? desc(range.startContainer, range.startOffset) : null,
          stack: String(new Error().stack)
            .split('\n')
            .slice(2, 5)
            .map((line) => line.trim().replace(/^at /, '').slice(0, 100)),
        })
      }
      return original.apply(this, args)
    }
  }
  const depth = () => undo[inner.currentMode].undoStack.length as number
  const add = undo.addToUndoStack
  undo.addToUndoStack = function (...args: unknown[]) {
    const before = depth()
    const result = add.apply(this, args)
    rec.entries.push({ t: Date.now(), before, after: depth() })
    return result
  }
  for (const kind of ['undo', 'redo']) {
    const original = undo[kind]
    undo[kind] = function (...args: unknown[]) {
      rec.engine++
      return original.apply(this, args)
    }
  }
  return true
}

function readLive(_body: Element, ch: string) {
  const w = window as any
  const inner = w.vditor.vditor
  const slot = inner.undo[inner.currentMode]
  const r = inner[inner.currentMode].element as HTMLElement
  const pending = inner[inner.currentMode]?.vmdeAfterRender
  const kids = Array.from(r.childNodes)
  const s = getSelection()
  const c = s?.rangeCount ? s.anchorNode : null
  let caretTop = -9
  if (c === r) caretTop = -1
  else if (c) {
    let n: Node | null = c
    while (n && n.parentNode !== r) n = n.parentNode
    caretTop = n ? kids.indexOf(n as ChildNode) : -2
  }
  return {
    keyList: w.__t625.keys as { key: string; ctrl: boolean; t: number }[],
    engine: w.__t625.engine as number,
    entries: (w.__t625.entries as unknown[]).length,
    depth: slot.undoStack.length as number,
    redoDepth: slot.redoStack.length as number,
    armed:
      !!pending?.options?.enableAddUndoStack && !!pending.options.enableInput,
    value: w.vditor.getValue() as string,
    blocks: kids.length,
    yBlocks: kids
      .map((n, i) => ((n.textContent ?? '').includes(ch) ? i : -1))
      .filter((i) => i >= 0),
    caretTop,
  }
}

const readRecord = () => {
  const rec = (window as any).__t625
  return {
    snaps: rec.snaps,
    inputs: rec.inputs,
    moves: rec.moves,
    muts: rec.muts,
    writes: rec.writes,
    enterAt: rec.enterAt as number,
  }
}

function focusRoot() {
  const inner = (window as any).vditor.vditor
  ;(inner[inner.currentMode].element as HTMLElement).focus()
}

function addControlSheet(_body: Element, css: string) {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  return document.adoptedStyleSheets.length
}

// --- Host recorder ---

const installHost = (ctx: Ctx) =>
  ctx.kit.host(
    (vscode, [fsPath]: [string]) => {
      const g = globalThis as any
      g.__t625Host ??= {}
      g.__t625Subs ??= []
      const record = { events: [] as unknown[] }
      g.__t625Host[fsPath] = record
      g.__t625Subs.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.document.uri.fsPath !== fsPath) return
          if (!event.contentChanges.length) return
          record.events.push({
            t: Date.now(),
            version: event.document.version,
            reason: event.reason ?? 0,
            dirty: event.document.isDirty,
            text: event.document.getText(),
          })
        }),
      )
    },
    [ctx.file],
  )

interface HostEvent {
  t: number
  version: number
  reason: number
  dirty: boolean
  text: string
}

const readHost = (ctx: Ctx) =>
  ctx.kit.host(
    (vscode, [fsPath]: [string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === fsPath,
      )
      return {
        text: document?.getText() ?? null,
        version: document?.version ?? -1,
        dirty: document?.isDirty ?? null,
        events: (globalThis as any).__t625Host[fsPath].events as HostEvent[],
      }
    },
    [ctx.file],
  )

const disposeHost = (kit: Kit) =>
  kit.host(() => {
    const g = globalThis as any
    for (const sub of g.__t625Subs ?? []) sub.dispose()
    g.__t625Subs = []
    g.__t625Host = {}
  }, [])

// --- Driver ---

// The typed character of the case being run (module state; cases run one at a time).
let CH = 'Y'
const live = (kit: Kit) => evalFrame(kit, readLive, CH)
const sha = (text: string | null) =>
  text === null
    ? null
    : createHash('sha256').update(text).digest('hex').slice(0, 12)

const press = (kit: Kit, keys: Keys, key: 'Return' | 'ctrl+z') =>
  keys === 'xtest' ? kit.xtest.key(key) : kit.workbox.keyboard.press('Enter')

// 'cdp-shift' presses Shift+Y with the Shift key down, as XTEST does (the plain CDP Y has no Shift).
const typeKey = (kit: Kit, keys: Keys, text: string) =>
  keys === 'xtest'
    ? kit.xtest.type(text)
    : keys === 'cdp-shift'
      ? kit.workbox.keyboard.press(`Shift+${text}`)
      : kit.workbox.keyboard.type(text)

// The text after the lead key, before Enter.
const baseOf = (c: Case) =>
  c.lead ? c.content.replace(c.anchor ?? '', `${c.anchor}${c.lead}`) : c.content

// The host text each outcome label stands for.
function hostLabel(c: Case, base: string, host: string | null) {
  if (host === null) return 'missing'
  if (c.expected !== null && host === c.expected) return 'expected'
  if (host === base) return 'unchanged'
  const anchor = c.anchor ? `${c.anchor}${c.lead ?? ''}` : null
  if (anchor && host === base.replace(anchor, `${anchor}${CH}`))
    return 'defect-prev'
  if (c.next && host === base.replace(c.next, `${CH}${c.next}`))
    return 'defect-next'
  return 'other'
}

const summary = (text: string | null, dirty: boolean | null) => ({
  len: text?.length ?? null,
  sha: sha(text),
  dirty,
})

// One Ctrl+Z by XTEST; waits for the engine call and a quiet host, then reads the state.
async function undoStep(ctx: Ctx, c: Case, step: number, ref: Row) {
  const { kit } = ctx
  const before = await live(kit)
  const hostBefore = await readHost(ctx)
  await press(kit, 'xtest', 'ctrl+z')
  let now = before
  for (const deadline = Date.now() + 3000; Date.now() < deadline; ) {
    await kit.workbox.waitForTimeout(100)
    now = await live(kit)
    if (now.engine > before.engine) break
  }
  let host = await readHost(ctx)
  let quiet = Date.now()
  for (const deadline = Date.now() + 6000; Date.now() < deadline; ) {
    await kit.workbox.waitForTimeout(100)
    const next = await readHost(ctx)
    if (next.version !== host.version) quiet = Date.now()
    host = next
    if (Date.now() - quiet >= 500) break
  }
  now = await live(kit)
  const base = baseOf(c)
  let label = 'other'
  if (host.text === c.content) label = 'opened'
  else if (c.lead && host.text === base) label = 'afterLead'
  else if (host.text === ref.finalText) label = 'afterKey'
  return {
    step,
    engineReached: now.engine > before.engine,
    host: { label, ...summary(host.text, host.dirty), text: host.text },
    hostReasons: host.events
      .slice(hostBefore.events.length)
      .map((e) => e.reason),
    blocks: now.blocks,
    yBlocks: now.yBlocks,
    caretTop: now.caretTop,
    depth: now.depth,
    redoDepth: now.redoDepth,
    viewIsOpened: now.value === ref.openedView,
    viewLen: now.value.length,
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one sequential measurement per case
async function runCase(kit: Kit, c: Case): Promise<Row> {
  const keys = c.keys ?? 'xtest'
  CH = c.ch ?? 'Y'
  const gap = c.gap ?? 100
  const row: Row = {
    id: c.id,
    mode: c.mode,
    route: c.anchor ? 'A' : 'B',
    keys,
    gapMs: gap,
    css: !!c.css,
    lead: c.lead ?? null,
    ch: CH,
  }
  let ctx: Ctx | undefined
  try {
    ctx = await openDocument(kit, `enter-${c.id}.md`, c.content, c.mode)
    expect(ctx.results[0].ok, 'exact open bytes, clean').toBe(true)
    await installHost(ctx)
    await waitForInitialUndoSnapshot(kit.frame())
    expect(await evalFrame(kit, installProbe, CH), 'recorder').toBe(true)
    if (c.css)
      row.controlSheets = await evalFrame(kit, addControlSheet, CONTROL_CSS)
    if (c.anchor)
      await select(ctx, c.anchor, { collapsed: true, offset: c.anchor.length })
    else {
      await evalFrame(kit, focusRoot, 0)
      await kit.xtest.key('ctrl+End')
      await kit.workbox.waitForTimeout(300)
    }
    if (c.lead) {
      await kit.xtest.type(c.lead)
      await kit.workbox.waitForTimeout(100)
    }
    const start = await live(kit)
    const hostStart = await readHost(ctx)
    const openedView = start.value
    row.blocksOpen = start.blocks
    row.openedViewLen = openedView.length
    const base = baseOf(c)

    await press(kit, keys, 'Return')
    await kit.workbox.waitForTimeout(gap)
    await typeKey(kit, keys, CH)

    // Settle: Y recorded 1 s ago, nothing armed, host changed and quiet for 400 ms (cap 6 s).
    let host = await readHost(ctx)
    let now = await live(kit)
    let quiet = Date.now()
    let settled = false
    for (const deadline = Date.now() + 6000; Date.now() < deadline; ) {
      await kit.workbox.waitForTimeout(100)
      now = await live(kit)
      const next = await readHost(ctx)
      if (next.version !== host.version) quiet = Date.now()
      host = next
      const y = now.keyList.filter((k) => k.key === CH).at(-1)
      if (
        y &&
        Date.now() - y.t >= 1000 &&
        !now.armed &&
        host.text !== hostStart.text &&
        Date.now() - quiet >= 400
      ) {
        settled = true
        break
      }
    }
    const rec = await evalFrame(kit, readRecord, 0)
    const atEnter = rec.snaps.find(
      (s: { label: string }) => s.label === 'atEnter',
    )
    const enterTop = atEnter?.caret?.top ?? null
    const enterIndex = enterTop
    row.settled = settled
    row.keysDelivered = {
      enter: now.keyList.some((k) => k.key === 'Enter'),
      key: now.keyList.some((k) => k.key === CH),
    }
    row.keyLog = now.keyList.map((k) => ({ ...k, t: k.t - rec.enterAt }))
    row.caretAtEnter = atEnter?.caret ?? null
    row.snaps = rec.snaps
    row.inputs = rec.inputs
    row.moves = rec.moves
    row.muts = rec.muts
    row.writes = rec.writes
    row.after = {
      enterTop: enterIndex,
      yBlocks: now.yBlocks,
      yIsNextBlock:
        enterIndex !== null &&
        now.yBlocks.length === 1 &&
        now.yBlocks[0] === enterIndex + 1,
      blocks: now.blocks,
      host: {
        label: hostLabel(c, base, host.text),
        ...summary(host.text, host.dirty),
        text: host.text,
      },
      hostSeq: host.events.slice(hostStart.events.length).map((e) => ({
        dtMs: e.t - rec.enterAt,
        reason: e.reason,
        len: e.text.length,
        text: e.text,
      })),
      viewLen: now.value.length,
      depth: now.depth,
      entries: now.entries,
    }
    expect(row.keysDelivered, 'Enter and the key delivered').toEqual({
      enter: true,
      key: true,
    })

    const ref = { finalText: host.text, openedView }
    row.undo = [await undoStep(ctx, c, 1, ref), await undoStep(ctx, c, 2, ref)]
  } catch (error) {
    row.error = firstLine(error)
  } finally {
    if (ctx) {
      await closeAll(kit, ctx.file).catch(() => undefined)
      await disposeHost(kit).catch(() => undefined)
    }
  }
  console.log(`[${LABEL}] ${JSON.stringify(row)}`)
  return row
}

async function runCases(
  kit: Kit,
  cases: Case[],
  attach: (name: string, body: string) => Promise<void>,
  name: string,
) {
  const rows: Row[] = []
  for (const c of cases) rows.push(await runCase(kit, c))
  await attach(`${name}.json`, JSON.stringify(rows, null, 1))
  expect(
    rows.filter((row) => row.error).map((row) => `${row.id}: ${row.error}`),
    'harness preconditions held',
  ).toEqual([])
}

// --- Cases ---

const ir625 = (
  id: string,
  at: 'middle' | 'last',
  o: Pick<Case, 'keys' | 'gap' | 'css' | 'lead' | 'ch'>,
): Case => {
  const lead = o.lead ?? ''
  const ch = o.ch ?? 'Y'
  const middle = at === 'middle'
  const anchor = middle ? 'delta.' : 'lima.'
  return {
    id,
    mode: 'ir',
    content: DOC,
    anchor,
    next: middle ? 'Echo' : undefined,
    expected: middle
      ? DOC.replace('delta.\n\n', `delta.${lead}\n\n${ch}\n\n`)
      : DOC.replace(/lima\.\n$/, `lima.${lead}\n\n${ch}\n`),
    ...o,
  }
}

const kind = (
  id: string,
  mode: Mode,
  block: string,
  o: { anchor: string | null; expected: string | null; lf?: boolean },
): Case => ({
  id: `${mode}-${id}`,
  mode,
  content: `${PREFIX}${block}${o.lf === false ? '' : '\n'}`,
  anchor: o.anchor,
  expected: o.expected,
})

const para = (mode: Mode, lf: boolean): Case =>
  kind(`paragraph-${lf ? 'lf' : 'nolf'}`, mode, LIMA, {
    anchor: 'lima.',
    lf,
    expected: lf ? `${PREFIX}${LIMA}\n\nY\n` : null,
  })
const heading = (mode: Mode, lf = true): Case =>
  kind(`heading-${lf ? 'lf' : 'nolf'}`, mode, '## Echo foxtrot', {
    anchor: 'foxtrot',
    lf,
    expected: lf ? `${PREFIX}## Echo foxtrot\n\nY\n` : null,
  })
const list = (mode: Mode, lf = true): Case =>
  kind(`list-${lf ? 'lf' : 'nolf'}`, mode, '- echo\n- foxtrot', {
    anchor: 'foxtrot',
    lf,
    expected: lf ? `${PREFIX}- echo\n- foxtrot\n- Y\n` : null,
  })
const quote = (mode: Mode): Case =>
  kind('blockquote', mode, '> Echo foxtrot golf.', {
    anchor: 'golf.',
    expected: null,
  })
const table = (mode: Mode, anchor: string | null = 'hotel'): Case => ({
  ...kind(`table${anchor ? '' : '-routeB'}`, mode, TABLE, {
    anchor,
    expected: null,
  }),
})
const code = (mode: Mode): Case =>
  kind('code', mode, CODE, {
    anchor: null,
    expected: `${PREFIX}\`\`\`js\nconst echo = 1\nY\n\`\`\`\n`,
  })
// The same case typing a lowercase `y`: Vditor's fixCJKPosition seeds a ZWSP into an empty block on a
// Shift-free keydown, which masks the empty paragraph's missing line box.
const lower = (c: Case): Case => ({
  ...c,
  id: `${c.id}-lowercase`,
  ch: 'y',
  expected: c.expected?.replaceAll('Y', 'y') ?? null,
})
const empty = (mode: Mode): Case => ({
  id: `${mode}-empty`,
  mode,
  content: '',
  anchor: null,
  expected: null,
})

test.describe('Enter new-paragraph probes', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test.afterEach(async ({ evaluateInVSCode }) => {
    await evaluateInVSCode(async (vscode) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', undefined, true)
    })
  })

  const setup = async (fixtures: {
    workbox: unknown
    electronApp: Parameters<typeof makeKit>[1]
    evaluateInVSCode: unknown
    baseDir: string
  }) => {
    const kit = await makeKit(
      fixtures.workbox,
      fixtures.electronApp,
      fixtures.evaluateInVSCode,
      fixtures.baseDir,
      LABEL,
    )
    // First open of a session is slower and can differ; measure none of it.
    const warm = await openDocument(kit, 'warm-up.md', DOC, 'ir')
    await waitForInitialUndoSnapshot(kit.frame())
    await closeAll(kit, warm.file)
    return kit
  }

  const attacher = () => async (name: string, body: string) => {
    await test.info().attach(name, { body, contentType: 'application/json' })
  }

  test('@probe Task 625 IR Enter then one key: XTEST, CDP, CSS control', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    await runCases(
      kit,
      [
        ir625('xtest-middle-100', 'middle', { gap: 100 }),
        ir625('xtest-middle-1000', 'middle', { gap: 1000 }),
        ir625('xtest-last-100', 'last', { gap: 100 }),
        ir625('xtest-last-1000', 'last', { gap: 1000 }),
        ir625('cdp-middle-100', 'middle', { gap: 100, keys: 'cdp' }),
        ir625('cdp-last-100', 'last', { gap: 100, keys: 'cdp' }),
        ir625('cdp-middle-1000', 'middle', { gap: 1000, keys: 'cdp' }),
        ir625('cdp-last-1000', 'last', { gap: 1000, keys: 'cdp' }),
        ir625('xtest-lower-middle-100', 'middle', { gap: 100, ch: 'y' }),
        ir625('xtest-lower-last-100', 'last', { gap: 100, ch: 'y' }),
        ir625('cdpshift-middle-100', 'middle', { gap: 100, keys: 'cdp-shift' }),
        ir625('cdpshift-last-100', 'last', { gap: 100, keys: 'cdp-shift' }),
        ir625('css-middle-100', 'middle', { gap: 100, css: true }),
        ir625('css-last-100', 'last', { gap: 100, css: true }),
        ir625('xfirst-middle-100', 'middle', { gap: 100, lead: 'X' }),
        ir625('xfirst-last-100', 'last', { gap: 100, lead: 'X' }),
      ],
      attacher(),
      'enter-625',
    )
  })

  test('@probe Task 627 IR document end by last-block kind', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    await runCases(
      kit,
      [
        para('ir', true),
        para('ir', false),
        heading('ir'),
        list('ir'),
        quote('ir'),
        code('ir'),
        table('ir'),
        empty('ir'),
        { ...para('ir', true), id: 'ir-paragraph-lf-routeB', anchor: null },
        table('ir', null),
        lower(para('ir', true)),
        lower(heading('ir')),
        lower(list('ir')),
        heading('ir', false),
        list('ir', false),
      ],
      attacher(),
      'enter-627-ir',
    )
  })

  test('@probe Task 627 WYSIWYG', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    await runCases(
      kit,
      [
        para('wysiwyg', true),
        para('wysiwyg', false),
        heading('wysiwyg'),
        list('wysiwyg'),
        quote('wysiwyg'),
        table('wysiwyg'),
        empty('wysiwyg'),
        lower(para('wysiwyg', true)),
      ],
      attacher(),
      'enter-627-wysiwyg',
    )
  })

  test('@probe Task 627 SV', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    await runCases(
      kit,
      [
        para('sv', true),
        para('sv', false),
        heading('sv'),
        list('sv'),
        quote('sv'),
        code('sv'),
        empty('sv'),
      ],
      attacher(),
      'enter-627-sv',
    )
  })
})
