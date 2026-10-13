/**
 * PROBE (Task 627, Part 2 S2b) — measures which step moves the caret when a document ends with a
 * fenced code block and the user presses Ctrl+End, Enter, then Shift+Y in IR. The S1 probe saw the
 * caret jump to the end of the first heading (`# ProbeY`); the expected contract is that Enter
 * inside a fenced code block stays a newline in the code (host text `…\nconst echo = 1\nY\n```\n`).
 * NOT a regression net: it asserts only harness preconditions (exact open bytes, keys delivered,
 * the recorder's positive controls) and prints one `[Task 627 code-end]` JSON line per leg plus a
 * JSON attachment.
 *
 * Legs: B = focus the editor, then Ctrl+End (the S1 route); A1 = Ctrl+End, then ArrowUp and End by
 * XTEST; A2 = a programmatic caret at the end of the code line; A3 = a mouse click at the end of the
 * code line. One WYSIWYG leg of route B is recorded for comparison.
 *
 * Read-only in-page wrappers record trusted keys, `beforeinput`/`input`, `selectionchange`, DOM
 * mutations, Selection / live-Range writes and `focus()` calls with a short stack tag, all tagged
 * with the current stage. Positive controls: a trusted keydown reaches the recorder, and the
 * programmatic caret of leg A2 must show up as a recorded Selection write.
 *
 * @probe — excluded from the default run; run with
 * `VMDE_XTEST=1 npm --prefix test/vscode-e2e run test:probes -- code-block-end-enter-probe.spec.ts`
 * inside the isolated Xvfb/Openbox shell of docs/os-keyboard-testing-setup.md.
 */
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

const LABEL = 'Task 627 code-end'
const HEAD = '# Probe\n\nAlpha bravo charlie delta.\n\n'
const LINE = 'const echo = 1'
const DOC = `${HEAD}\`\`\`js\n${LINE}\n\`\`\`\n`
// The task contract: Enter inside a fenced code block stays a newline in the code.
const EXPECTED = `${HEAD}\`\`\`js\n${LINE}\nY\n\`\`\`\n`
const CH = 'Y'

type Route = 'B' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7'
type Row = Record<string, unknown>

interface Leg {
  id: string
  mode: Mode
  route: Route
  /** Skip Enter: type the character straight after the caret was placed. */
  noEnter?: boolean
}

// --- Page side (serialized into the webview; no outer references) ---

function installProbe(_body: Element, _arg: number): boolean {
  const w = window as any
  const inner = w.vditor?.vditor
  if (!inner) return false
  if (w.__t627) return true
  const root = () => inner[inner.currentMode].element as HTMLElement
  const rec: any = {
    stage: 'init',
    cur: '',
    keys: [],
    inputs: [],
    moves: [],
    muts: [],
    writes: [],
    snaps: [],
  }
  w.__t627 = rec

  const kids = () => Array.from(root().childNodes)
  const topOf = (node: Node | null): number => {
    if (!node) return -9
    if (node === root()) return -1
    let n: Node | null = node
    while (n && n.parentNode !== root()) n = n.parentNode
    return n ? kids().indexOf(n as ChildNode) : -2
  }
  const pathOf = (node: Node | null): string => {
    if (!node) return ''
    const parts: string[] = []
    let n: Node | null = node
    while (n && n !== root()) {
      const p: Node | null = n.parentNode
      const idx = p ? Array.prototype.indexOf.call(p.childNodes, n) : 0
      const name =
        n.nodeType === 3
          ? '#text'
          : `${n.nodeName.toLowerCase()}${
              (n as Element).className
                ? `.${String((n as Element).className)
                    .trim()
                    .split(/\s+/)
                    .join('.')}`
                : ''
            }`
      parts.unshift(`${name}[${idx}]`)
      n = p
    }
    return parts.join(' > ')
  }
  const point = (node: Node | null, offset: number) => {
    if (!node) return null
    const text = node.nodeType === 3 ? (node as Text).data : null
    return {
      top: topOf(node),
      path: pathOf(node),
      tag: node.nodeType === 3 ? '#text' : node.nodeName.toLowerCase(),
      offset,
      len: text !== null ? text.length : node.childNodes.length,
      around:
        text !== null
          ? `${text.slice(Math.max(0, offset - 12), offset)}|${text.slice(offset, offset + 12)}`
          : null,
      isRoot: node === root(),
    }
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one read-only classification of the caret's container
  const classify = (node: Node | null) => {
    const el = node
      ? node.nodeType === 1
        ? (node as Element)
        : node.parentElement
      : null
    if (!el) return null
    const block = el.closest('[data-type]')
    const top = el.closest('.vditor-ir__node[data-block="0"], [data-block]')
    const marker = el.closest('.vditor-ir__marker')
    const codeBlock = el.closest('[data-type="code-block"]')
    const markers = codeBlock
      ? Array.from(codeBlock.querySelectorAll('.vditor-ir__marker'))
      : []
    return {
      blockType: block?.getAttribute('data-type') ?? null,
      blockTop: top ? topOf(top) : topOf(el),
      inMarkerPre: !!el.closest('.vditor-ir__marker--pre'),
      inPreview: !!el.closest('.vditor-ir__preview'),
      inCodeEl: !!el.closest('code'),
      inCodeBlock: !!codeBlock,
      markerText: marker ? (marker.textContent ?? '').slice(0, 12) : null,
      markerIndexInBlock: marker ? markers.indexOf(marker) : null,
      markerCountInBlock: markers.length,
      inTrailingParagraph: !!el.closest('[data-vmde-trailing]'),
      inHeading: !!el.closest('h1,h2,h3,h4,h5,h6'),
      headingText: el.closest('h1,h2,h3,h4,h5,h6')
        ? (el.closest('h1,h2,h3,h4,h5,h6')?.textContent ?? '').slice(0, 30)
        : null,
    }
  }
  const sel = () => {
    const s = getSelection()
    if (!s?.rangeCount) return null
    return {
      collapsed: s.isCollapsed,
      anchor: point(s.anchorNode, s.anchorOffset),
      focus: point(s.focusNode, s.focusOffset),
      where: classify(s.anchorNode),
      inRoot: !!s.anchorNode && root().contains(s.anchorNode),
      active: document.activeElement
        ? `${document.activeElement.nodeName.toLowerCase()}.${String(document.activeElement.className).slice(0, 40)}`
        : null,
    }
  }
  const dom = () => {
    const all = kids()
    const lastTwo = all.slice(-2).map((n, i) => {
      const index = all.length - 2 + i
      if (n.nodeType !== 1)
        return { index, tag: '#text', text: (n.nodeValue ?? '').slice(0, 80) }
      const el = n as HTMLElement
      return {
        index,
        tag: el.nodeName.toLowerCase(),
        cls: el.className,
        dataType: el.getAttribute('data-type'),
        dataBlock: el.getAttribute('data-block'),
        trailing: el.hasAttribute('data-vmde-trailing'),
        children: el.childNodes.length,
        h: Math.round(el.getBoundingClientRect().height * 10) / 10,
        html: el.outerHTML.slice(0, 900),
      }
    })
    return {
      blocks: all.length,
      first: (all[0]?.textContent ?? '').slice(0, 30),
      lastTwo,
    }
  }
  const snap = (label: string) => {
    const out = {
      label,
      stage: rec.stage,
      t: Date.now(),
      sel: sel(),
      dom: dom(),
    }
    rec.snaps.push(out)
    return out
  }
  w.__t627snap = snap
  const stackTag = () =>
    String(new Error().stack)
      .split('\n')
      .slice(3, 9)
      .map((line) =>
        line
          .trim()
          .replace(/^at /, '')
          .replace(
            /\(?[a-z-]+:\/\/[^)\s]*\/([^/)\s?]+)(\?[^:)\s]*)?:(\d+):(\d+)\)?/,
            '$1:$3:$4',
          )
          .slice(0, 110),
      )

  const frames2 = (fn: () => void) =>
    requestAnimationFrame(() => requestAnimationFrame(fn))
  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted) return
      rec.cur = `keydown:${event.key}`
      rec.keys.push({
        stage: rec.stage,
        key: event.key,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        t: Date.now(),
        defaultPrevented: false,
      })
      if (event.key === 'Enter') {
        snap('atEnterKeydown')
        frames2(() => snap('enter+2raf'))
      }
      // Whether any handler after this capture listener cancelled the key.
      const index = rec.keys.length - 1
      setTimeout(() => {
        rec.keys[index].defaultPrevented = event.defaultPrevented
      }, 0)
    },
    true,
  )
  document.addEventListener(
    'beforeinput',
    (event) => {
      rec.cur = 'beforeinput'
      if (rec.inputs.length >= 60) return
      const e = event as InputEvent
      const s = getSelection()
      const target = e.getTargetRanges?.()[0]
      rec.inputs.push({
        stage: rec.stage,
        phase: 'beforeinput',
        t: Date.now(),
        type: e.inputType,
        data: e.data,
        cancelable: e.cancelable,
        sel: s?.rangeCount ? point(s.anchorNode, s.anchorOffset) : null,
        selWhere: s?.rangeCount ? classify(s.anchorNode) : null,
        target: target
          ? {
              ...point(target.startContainer, target.startOffset),
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
      const s = getSelection()
      if (rec.inputs.length < 60)
        rec.inputs.push({
          stage: rec.stage,
          phase: 'input',
          t: Date.now(),
          type: e.inputType,
          data: e.data,
          sel: s?.rangeCount ? point(s.anchorNode, s.anchorOffset) : null,
          selWhere: s?.rangeCount ? classify(s.anchorNode) : null,
        })
    },
    true,
  )
  const nodeInfo = (n: Node) =>
    n.nodeType === 3
      ? `#text(${(n as Text).data.length})`
      : `${n.nodeName.toLowerCase()}${
          (n as Element).className
            ? `.${String((n as Element).className)
                .trim()
                .split(/\s+/)
                .join('.')}`
            : ''
        }`
  new MutationObserver((records) => {
    const s = getSelection()
    const now = s?.rangeCount ? point(s.anchorNode, s.anchorOffset) : null
    for (const m of records) {
      if (rec.muts.length >= 80) return
      rec.muts.push({
        selAfterBatch: now ? `${now.path}@${now.offset}` : null,
        stage: rec.stage,
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
  let last = ''
  document.addEventListener('selectionchange', () => {
    if (rec.moves.length >= 100) return
    const s = getSelection()
    const d = s?.rangeCount ? point(s.anchorNode, s.anchorOffset) : null
    const key = JSON.stringify(d)
    if (key === last) return
    last = key
    rec.moves.push({
      stage: rec.stage,
      t: Date.now(),
      after: rec.cur,
      ...d,
      where: s?.rangeCount ? classify(s.anchorNode) : null,
    })
  })

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one read-only write record
  const log = (fn: string, args: unknown[]) => {
    if (rec.writes.length >= 120) return
    const range = args[0] instanceof Range ? args[0] : null
    const argNode = args[0] instanceof Node ? (args[0] as Node) : null
    const s = getSelection()
    rec.writes.push({
      stage: rec.stage,
      t: Date.now(),
      fn,
      selBefore: s?.rangeCount ? point(s.anchorNode, s.anchorOffset) : null,
      arg: range
        ? point(range.startContainer, range.startOffset)
        : argNode
          ? point(argNode, typeof args[1] === 'number' ? args[1] : 0)
          : null,
      stack: stackTag(),
    })
  }
  const selProto = Selection.prototype as any
  for (const name of [
    'addRange',
    'removeAllRanges',
    'setBaseAndExtent',
    'collapse',
    'setPosition',
    'extend',
    'selectAllChildren',
    'collapseToStart',
    'collapseToEnd',
    'modify',
  ]) {
    const original = selProto[name]
    if (typeof original !== 'function') continue
    selProto[name] = function (...args: unknown[]) {
      log(`Selection.${name}`, args)
      return original.apply(this, args)
    }
  }
  // Live-Range setters count only when the Range is the document selection's own Range.
  const rangeProto = Range.prototype as any
  for (const name of [
    'setStart',
    'setEnd',
    'setStartBefore',
    'setStartAfter',
    'setEndBefore',
    'setEndAfter',
    'selectNode',
    'selectNodeContents',
    'collapse',
  ]) {
    const original = rangeProto[name]
    if (typeof original !== 'function') continue
    rangeProto[name] = function (...args: unknown[]) {
      const s = getSelection()
      if (s?.rangeCount && s.getRangeAt(0) === this) {
        const args2: unknown[] = [this]
        log(`LiveRange.${name}`, args2)
      }
      return original.apply(this, args)
    }
  }
  // VMDE's caret authority entry and Vditor's undo caret capture (pass-through).
  const requestCaret = w.__vmdeRequestCaret
  if (typeof requestCaret === 'function')
    w.__vmdeRequestCaret = (intent: any) => {
      const s = getSelection()
      rec.writes.push({
        stage: rec.stage,
        t: Date.now(),
        fn: '__vmdeRequestCaret',
        intent: JSON.stringify(intent, (_key, value) =>
          value instanceof Node ? `<${value.nodeName.toLowerCase()}>` : value,
        ).slice(0, 200),
        selBefore: s?.rangeCount ? point(s.anchorNode, s.anchorOffset) : null,
        stack: stackTag(),
      })
      return requestCaret(intent)
    }
  const undo = inner.undo
  const addCaret = undo?.addCaret
  if (typeof addCaret === 'function')
    undo.addCaret = function (...args: unknown[]) {
      const s = getSelection()
      rec.writes.push({
        stage: rec.stage,
        t: Date.now(),
        fn: 'Undo.addCaret',
        wbrInRoot: !!root().querySelector('wbr'),
        selBefore: s?.rangeCount ? point(s.anchorNode, s.anchorOffset) : null,
        stack: stackTag(),
      })
      return addCaret.apply(this, args)
    }
  const lute = inner.lute
  const spin = lute?.SpinVditorIRDOM
  if (typeof spin === 'function') {
    rec.spins = []
    lute.SpinVditorIRDOM = function (html: string, ...rest: unknown[]) {
      const out = spin.call(this, html, ...rest)
      if (rec.spins.length < 20)
        rec.spins.push({
          stage: rec.stage,
          t: Date.now(),
          inWbr: (html.match(/<wbr>/g) ?? []).length,
          outWbr: (String(out).match(/<wbr>/g) ?? []).length,
          inCodes: (html.match(/<code[ >]/g) ?? []).length,
          outCodes: (String(out).match(/<code[ >]/g) ?? []).length,
          inCode: html
            .slice(
              html.indexOf('vditor-ir__marker--pre'),
              html.indexOf('vditor-ir__preview'),
            )
            .slice(0, 600),
          outCode: String(out)
            .slice(
              String(out).indexOf('vditor-ir__marker--pre'),
              String(out).indexOf('vditor-ir__preview'),
            )
            .slice(0, 600),
        })
      return out
    }
  }
  const focusOriginal = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function (...args: any[]) {
    log('HTMLElement.focus', [this])
    return focusOriginal.apply(this, args as any)
  }
  const scrollOriginal = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function (...args: any[]) {
    log('Element.scrollIntoView', [this])
    return scrollOriginal.apply(this, args as any)
  }
  return true
}

function setStage(_body: Element, stage: string) {
  ;(window as any).__t627.stage = stage
  return stage
}

function snapNow(_body: Element, label: string) {
  return (window as any).__t627snap(label)
}

// A collapsed caret inside the code block's rendered preview (the spot Ctrl+End reaches), written by
// the page itself: separates "the caret is in the preview" from "the Ctrl+End key".
function placeInPreview() {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  root.focus()
  const preview = root.querySelector(
    '[data-type="code-block"] .vditor-ir__preview',
  )
  if (!preview) return false
  const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT)
  let last: Text | null = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) last = n as Text
  if (!last) return false
  getSelection()?.collapse(last, last.data.length)
  return true
}

function focusRoot() {
  const inner = (window as any).vditor.vditor
  ;(inner[inner.currentMode].element as HTMLElement).focus()
}

function readRecord() {
  const rec = (window as any).__t627
  return {
    keys: rec.keys,
    inputs: rec.inputs,
    moves: rec.moves,
    muts: rec.muts,
    writes: rec.writes,
    snaps: rec.snaps,
    spins: rec.spins ?? [],
  }
}

// Where to click so the caret lands at the end of the code line: the end of the code text's last
// line box, as viewport coordinates of the webview's own document.
function codeLineEnd() {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  const block = root.querySelector('[data-type="code-block"]')
  const code = block?.querySelector(
    'pre:not(.vditor-ir__preview) code, .vditor-ir__marker--pre code, pre.vditor-ir__marker--pre',
  ) as HTMLElement | null
  if (!code) return null
  const range = document.createRange()
  range.selectNodeContents(code)
  const rects = range.getClientRects()
  const rect = rects.length
    ? rects[rects.length - 1]
    : code.getBoundingClientRect()
  return {
    x: Math.round(rect.right + 2),
    y: Math.round(rect.top + rect.height / 2),
    visible: code.getClientRects().length > 0,
    text: (code.textContent ?? '').slice(0, 40),
  }
}

// --- Host recorder ---

const installHost = (ctx: Ctx) =>
  ctx.kit.host(
    (vscode, [fsPath]: [string]) => {
      const g = globalThis as any
      g.__t627Host ??= {}
      g.__t627Subs ??= []
      const record = { events: [] as unknown[] }
      g.__t627Host[fsPath] = record
      g.__t627Subs.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.document.uri.fsPath !== fsPath) return
          if (!event.contentChanges.length) return
          record.events.push({
            t: Date.now(),
            version: event.document.version,
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
        events: (globalThis as any).__t627Host[fsPath].events as HostEvent[],
      }
    },
    [ctx.file],
  )

const disposeHost = (kit: Kit) =>
  kit.host(() => {
    const g = globalThis as any
    for (const sub of g.__t627Subs ?? []) sub.dispose()
    g.__t627Subs = []
    g.__t627Host = {}
  }, [])

// --- Driver ---

const stage = (kit: Kit, name: string) => evalFrame(kit, setStage, name)
const snap = (kit: Kit, label: string) => evalFrame(kit, snapNow, label)

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one sequential measurement per leg
async function runLeg(kit: Kit, leg: Leg): Promise<Row> {
  const row: Row = {
    id: leg.id,
    mode: leg.mode,
    route: leg.route,
    noEnter: !!leg.noEnter,
  }
  let ctx: Ctx | undefined
  try {
    ctx = await openDocument(kit, `code-end-${leg.id}.md`, DOC, leg.mode)
    expect(ctx.results[0].ok, 'exact open bytes, clean').toBe(true)
    await installHost(ctx)
    await waitForInitialUndoSnapshot(kit.frame())
    expect(await evalFrame(kit, installProbe, 0), 'recorder').toBe(true)
    const hostStart = await readHost(ctx)
    row.opened = await snap(kit, 'opened')

    // (a) the caret's landing spot.
    await stage(kit, 'place')
    if (leg.route === 'A2' || leg.route === 'A4') {
      await select(ctx, LINE, { collapsed: true, offset: LINE.length })
      if (leg.route === 'A4') {
        // Ctrl+End pressed with the caret already at the end of the code line.
        await snap(kit, 'beforeCtrlEnd')
        await stage(kit, 'ctrlEnd')
        await kit.xtest.key('ctrl+End')
        await kit.workbox.waitForTimeout(400)
        row.afterCtrlEnd = await snap(kit, 'afterCtrlEnd')
      }
    } else if (leg.route === 'A6') {
      // Caret at the end of the paragraph above, then ArrowDown into the code block.
      await select(ctx, 'delta.', { collapsed: true, offset: 'delta.'.length })
      for (const n of [1, 2, 3]) {
        await stage(kit, `down${n}`)
        await kit.xtest.key('Down')
        await kit.workbox.waitForTimeout(300)
        row[`afterDown${n}`] = await snap(kit, `afterDown${n}`)
      }
    } else if (leg.route === 'A5') {
      row.placedInPreview = await evalFrame(kit, placeInPreview, 0)
      await kit.workbox.waitForTimeout(300)
    } else if (leg.route === 'A3') {
      await evalFrame(kit, focusRoot, 0)
      const spot = await evalFrame(kit, codeLineEnd, 0)
      row.clickSpot = spot
      if (spot) {
        const body = kit.frame().locator('body')
        await body.click({ position: { x: spot.x, y: spot.y } })
      }
      await kit.workbox.waitForTimeout(300)
    } else {
      await evalFrame(kit, focusRoot, 0)
      await stage(kit, 'ctrlEnd')
      await kit.xtest.key('ctrl+End')
      await kit.workbox.waitForTimeout(400)
      row.afterCtrlEnd = await snap(kit, 'afterCtrlEnd')
      if (leg.route === 'A1') {
        await stage(kit, 'up')
        await kit.xtest.key('Up')
        await kit.workbox.waitForTimeout(300)
        row.afterUp = await snap(kit, 'afterUp')
        await stage(kit, 'lineEnd')
        await kit.xtest.key('End')
        await kit.workbox.waitForTimeout(300)
      }
    }
    row.beforeEnter = await snap(kit, 'beforeEnter')

    // (b) Enter.
    if (!leg.noEnter) {
      await stage(kit, 'enter')
      await kit.xtest.key('Return')
      await kit.workbox.waitForTimeout(600)
      row.afterEnter = await snap(kit, 'afterEnter')
    }

    // (c) Shift+Y by XTEST, then wait for the host to settle.
    await stage(kit, 'Y')
    await kit.xtest.type(CH)
    let host = await readHost(ctx)
    let quiet = Date.now()
    const t0 = Date.now()
    for (const deadline = Date.now() + 6000; Date.now() < deadline; ) {
      await kit.workbox.waitForTimeout(100)
      const next = await readHost(ctx)
      if (next.version !== host.version) quiet = Date.now()
      host = next
      if (
        Date.now() - t0 >= 1200 &&
        host.text !== hostStart.text &&
        Date.now() - quiet >= 500
      )
        break
    }
    row.afterY = await snap(kit, 'afterY')
    const rec = await evalFrame(kit, readRecord, 0)
    row.keys = rec.keys
    row.inputs = rec.inputs
    row.moves = rec.moves
    row.muts = rec.muts
    row.writes = rec.writes
    row.spins = rec.spins
    row.host = {
      text: host.text,
      dirty: host.dirty,
      matchesContract: host.text === EXPECTED,
      yOnHeading: host.text?.startsWith('# ProbeY') ?? false,
      seq: host.events
        .slice(hostStart.events.length)
        .map((e) => ({ version: e.version, text: e.text })),
    }
    row.controls = {
      ctrlEndKeydownSeen:
        leg.route === 'A2' ||
        leg.route === 'A3' ||
        leg.route === 'A5' ||
        leg.route === 'A6'
          ? null
          : rec.keys.some((k: { key: string }) => k.key === 'End'),
      enterKeydownSeen: rec.keys.some(
        (k: { key: string }) => k.key === 'Enter',
      ),
      yKeydownSeen: rec.keys.some((k: { key: string }) => k.key === CH),
      programmaticSelectionWriteSeen:
        leg.route === 'A2' || leg.route === 'A5'
          ? rec.writes.some(
              (w: { stage: string; fn: string }) =>
                w.stage === 'place' &&
                (w.fn === 'Selection.addRange' ||
                  w.fn === 'Selection.collapse'),
            )
          : null,
    }
    row.keysDelivered = {
      enter:
        !!leg.noEnter ||
        rec.keys.some((k: { key: string }) => k.key === 'Enter'),
      key: rec.keys.some((k: { key: string }) => k.key === CH),
    }
    expect(row.keysDelivered, 'Enter and the key delivered').toEqual({
      enter: true,
      key: true,
    })
    const controls = row.controls as Record<string, boolean | null>
    expect(
      controls.ctrlEndKeydownSeen ?? true,
      'positive control: End/ctrl+End keydown',
    ).toBe(true)
    expect(
      controls.programmaticSelectionWriteSeen ?? true,
      'positive control: Selection write recorded',
    ).toBe(true)
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

test.describe('Code-block-end Enter caret probe @probe', () => {
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

  test('@probe Task 627 S2b IR code block at document end: Ctrl+End, Enter, Shift+Y', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      LABEL,
    )
    // First open of a session is slower and can differ; measure none of it.
    const warm = await openDocument(kit, 'warm-up.md', DOC, 'ir')
    await waitForInitialUndoSnapshot(kit.frame())
    await closeAll(kit, warm.file)

    const legs: Leg[] = [
      { id: 'ir-B-ctrlend', mode: 'ir', route: 'B' },
      { id: 'ir-A1-ctrlend-up-end', mode: 'ir', route: 'A1' },
      { id: 'ir-A2-programmatic', mode: 'ir', route: 'A2' },
      { id: 'ir-A3-click', mode: 'ir', route: 'A3' },
      { id: 'ir-A4-code-end-then-ctrlend', mode: 'ir', route: 'A4' },
      { id: 'ir-A5-programmatic-preview', mode: 'ir', route: 'A5' },
      { id: 'ir-A6-arrow-down-from-paragraph', mode: 'ir', route: 'A6' },
      {
        id: 'ir-A7-ctrlend-then-Y-no-enter',
        mode: 'ir',
        route: 'B',
        noEnter: true,
      },
      { id: 'wysiwyg-B-ctrlend', mode: 'wysiwyg', route: 'B' },
    ]
    const rows: Row[] = []
    for (const leg of legs) rows.push(await runLeg(kit, leg))
    await test.info().attach('code-block-end-enter.json', {
      body: JSON.stringify(rows, null, 1),
      contentType: 'application/json',
    })
    expect(
      rows.filter((row) => row.error).map((row) => `${row.id}: ${row.error}`),
      'harness preconditions held',
    ).toEqual([])
  })
})
