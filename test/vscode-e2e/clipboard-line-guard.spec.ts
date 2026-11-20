import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  docText,
  ExtensionId,
  reopenVmdeFixture,
  settle,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  type wf,
} from './webview-helpers'

// Task 733/037: a collapsed Ctrl+C or Ctrl+X expands to the caret's line (Task 385). Before this
// task, a caret at an element point (`UL,1` between two items, the surface `PRE,n` between two
// blocks) reached the editable `<pre>` through `closest`, so the whole document was selected:
// Ctrl+C disclosed it and Ctrl+X deleted it. One arrow key produced that caret: ArrowDown or
// ArrowUp across a `---` into a list lands at `UL,0` or `UL,len` (gap-nav `placeCaretAtEdge`).
//
// Contract checked here, in VS Code's real webview and with its real system clipboard:
// - a one-sided edge (`UL,0`, `UL,len`) copies and cuts exactly the edge line, the same as a text
//   caret in that line does;
// - an ambiguous point keeps the clipboard sentinel and the document;
// - text carets, explicit selections and Source mode keep today's behaviour;
// - the main thread never blocks for 50 ms or more at x1, x4 and x16.
//
// Replay off: no test runs Undo, Redo, Replace or a mode switch before its measured gesture, so the
// unit history never replays. Each case opens its own uniquely named document, because VS Code keeps
// one TextDocument per path. Every gesture is a real key, and a window capture listener records the
// caret the before-event saw, so a shortcut that never reached the webview cannot pass.

type Frame = ReturnType<typeof wf>
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>
type Mode = 'ir' | 'wysiwyg' | 'sv'

const SENTINEL = 'SENTINEL-037-keep'
const DECLINE_WAIT_MS = 1000
const BUDGET_MS = 50

const FIXTURE = [
  '# Guard fixture',
  '',
  'Head paragraph ALPHA.',
  '',
  '- item one BRAVO',
  '- item two CHARLIE',
  '',
  'Middle paragraph KILO.',
  '',
  '---',
  '',
  '- item three DELTA',
  '- item four ECHO',
  '',
  '---',
  '',
  'Tail paragraph ZULU.',
  '',
].join('\n')

// Source mode re-spins its text through Lute after a cut, which rewrites `---` and merges blank
// lines (clipboard-collapsed.spec.ts). Adjacent lines with no rule are byte-stable.
const SV_FIXTURE = 'Alpha line ALPHA\nBravo line BRAVO\nCharlie line CHARLIE\n'

const CONFIG_KEY = 'editor.defaultMode'

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(args[0], undefined, vscode.ConfigurationTarget.Global)
    },
    [CONFIG_KEY],
  )
})

let docCount = 0

/** Open `text` in a new uniquely named file in `mode`, settled, with the before-event recorder. */
async function openIn(
  evaluateInVSCode: Evaluate,
  workbox: import('@playwright/test').Page,
  baseDir: string,
  mode: Mode,
  name: string,
  text: string,
): Promise<{ frame: Frame; file: string; opening: string }> {
  const file = path.join(baseDir, `guard-${docCount++}-${name}.md`)
  writeFileSync(file, text)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(args[0], args[1], vscode.ConfigurationTarget.Global)
      await vscode.extensions.getExtension(args[2])?.activate()
    },
    [CONFIG_KEY, mode, ExtensionId],
  )
  const frame = await reopenVmdeFixture(
    evaluateInVSCode,
    workbox,
    file,
    60_000,
    `.vditor-${mode}`,
  )
  await waitForE2EReadiness(
    frame,
    (s) => s.routerReady && s.editorEpoch > 0 && s.mode === mode,
    { message: `the editor opened in ${mode}`, timeout: 60_000 },
  )
  await waitForInitialUndoSnapshot(frame, 30_000)
  await installRecorder(frame)
  const opening = await docText(evaluateInVSCode, file)
  return { frame, file, opening }
}

/**
 * Records, for every `beforecopy`/`beforecut`, the caret it saw and its span. The window capture
 * listener runs before clipboard-line.ts's document capture listener, and the window bubble
 * listener after every listener on the path, so the span is an upper bound of the guard's cost.
 */
const installRecorder = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    interface Seen {
      type: string
      caret: boolean
      container: string
      offset: number
      start: number
      end: number
    }
    const w = window as unknown as {
      __guardSeen: Seen[]
      __guardPerf: { long: unknown[]; events: unknown[] }
    }
    w.__guardSeen = []
    w.__guardPerf = { long: [], events: [] }
    const describe = (node: Node): string => {
      // Vditor keeps all three mode surfaces in the DOM and appends WYSIWYG first (initUI), so a
      // combined selector would find the hidden WYSIWYG surface in IR. Read the live mode's surface.
      const v = (
        window as unknown as {
          vditor: {
            vditor: { currentMode: string } & Record<
              string,
              { element: HTMLElement }
            >
          }
        }
      ).vditor.vditor
      const surface = v[v.currentMode].element
      if (node === surface) return 'SURFACE'
      if (node.nodeType !== Node.ELEMENT_NODE) return 'TEXT'
      const el = node as Element
      const same = surface ? [...surface.querySelectorAll(el.tagName)] : []
      return `${el.tagName}#${same.indexOf(el)}`
    }
    for (const type of ['beforecopy', 'beforecut']) {
      window.addEventListener(
        type,
        () => {
          const selection = getSelection()
          const range =
            selection && selection.rangeCount > 0
              ? selection.getRangeAt(0)
              : null
          w.__guardSeen.push({
            type,
            caret: range !== null && range.toString() === '',
            container: range ? describe(range.startContainer) : '',
            offset: range ? range.startOffset : -1,
            start: performance.now(),
            end: -1,
          })
        },
        true,
      )
      window.addEventListener(type, () => {
        const last = w.__guardSeen.at(-1)
        if (last && last.end < 0) last.end = performance.now()
      })
    }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        w.__guardPerf.long.push([entry.startTime, entry.duration])
    }).observe({ type: 'longtask', buffered: false })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        w.__guardPerf.events.push([entry.startTime, entry.duration])
    }).observe({
      type: 'event',
      durationThreshold: 16,
      buffered: false,
    } as PerformanceObserverInit)
  })

interface Seen {
  type: string
  caret: boolean
  container: string
  offset: number
  start: number
  end: number
}

/**
 * Read and clear what the recorder saw. Only long tasks and Event Timing entries that start at or
 * after the latest key mark count: entries of the caret placement before it are delivered late.
 */
const takeSeen = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const w = window as unknown as {
      __guardSeen: Seen[]
      __guardPerf: {
        long: Array<[number, number]>
        events: Array<[number, number]>
      }
      __guardKeyAt?: number
    }
    const since = w.__guardKeyAt ?? 0
    const keep = (entries: Array<[number, number]>) =>
      entries.filter(([start]) => start >= since).map(([, d]) => d)
    const out = {
      seen: w.__guardSeen,
      long: keep(w.__guardPerf.long),
      events: keep(w.__guardPerf.events),
    }
    w.__guardSeen = []
    w.__guardPerf = { long: [], events: [] }
    return out
  }) as Promise<{ seen: Seen[]; long: number[]; events: number[] }>

/** Mark the key time; long tasks and events before it are not the gesture's. */
const markKey = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    ;(window as unknown as { __guardKeyAt: number }).__guardKeyAt =
      performance.now()
  })

const readClip = (evaluateInVSCode: Evaluate) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode')) => vscode.env.clipboard.readText(),
    [],
  ) as Promise<string>

const writeClip = (evaluateInVSCode: Evaluate, text: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.env.clipboard.writeText(args[0])
    },
    [text],
  )

/** Click the surface, then put a collapsed caret `at` characters into the text `needle`. */
async function textCaret(
  frame: Frame,
  mode: Mode,
  needle: string,
  at: number,
): Promise<void> {
  await frame
    .locator(`.vditor-${mode}`)
    .first()
    .click({ position: { x: 4, y: 4 } })
  await frame.locator('body').evaluate(
    (_el, args) => {
      const [m, text, offset] = args as [string, string, number]
      const root = document.querySelector(
        m === 'sv' ? 'pre.vditor-sv' : `.vditor-${m} > pre.vditor-reset`,
      ) as HTMLElement
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.textContent ?? '').indexOf(text)
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n, i + offset)
        r.collapse(true)
        getSelection()?.removeAllRanges()
        getSelection()?.addRange(r)
        root.focus()
        return
      }
      throw new Error(`no text ${text}`)
    },
    [mode, needle, at] as [string, string, number],
  )
}

/** An element point: `(nth UL, offset)`, or `(surface, index of the nth child with tag)`. */
type ElementPoint =
  | { kind: 'ul'; nth: number; offset: number }
  | { kind: 'surface'; tag: string; nth: number }

/** Click the surface, then put a collapsed caret at an element point. Returns its description. */
async function elementCaret(
  frame: Frame,
  mode: Mode,
  point: ElementPoint,
): Promise<{ container: string; offset: number }> {
  await frame
    .locator(`.vditor-${mode}`)
    .first()
    .click({ position: { x: 4, y: 4 } })
  return (await frame.locator('body').evaluate(
    (_el, args) => {
      const [m, json] = args as [string, string]
      const p = JSON.parse(json) as ElementPoint
      const root = document.querySelector(
        `.vditor-${m} > pre.vditor-reset`,
      ) as HTMLElement
      let node: Node
      let offset: number
      let container: string
      if (p.kind === 'ul') {
        node = root.querySelectorAll('ul')[p.nth] as Element
        offset = p.offset < 0 ? node.childNodes.length : p.offset
        container = `UL#${p.nth}`
      } else {
        const children = [...root.childNodes]
        const target = children.filter(
          (c) => c.nodeName === p.tag.toUpperCase(),
        )[p.nth]
        node = root
        offset = children.indexOf(target as ChildNode)
        container = 'SURFACE'
      }
      if (!node || offset < 0) throw new Error(`no point ${json}`)
      const r = document.createRange()
      r.setStart(node, offset)
      r.collapse(true)
      getSelection()?.removeAllRanges()
      getSelection()?.addRange(r)
      root.focus()
      return { container, offset }
    },
    [mode, JSON.stringify(point)] as [string, string],
  )) as { container: string; offset: number }
}

/** The live caret, described like the recorder does. */
const liveCaret = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    // Vditor keeps all three mode surfaces in the DOM and appends WYSIWYG first (initUI), so a
    // combined selector would find the hidden WYSIWYG surface in IR. Read the live mode's surface.
    const v = (
      window as unknown as {
        vditor: {
          vditor: { currentMode: string } & Record<
            string,
            { element: HTMLElement }
          >
        }
      }
    ).vditor.vditor
    const surface = v[v.currentMode].element
    const selection = getSelection()
    if (!selection || selection.rangeCount === 0)
      return { caret: false, container: '', offset: -1 }
    const range = selection.getRangeAt(0)
    const node = range.startContainer
    let container = 'TEXT'
    if (node === surface) container = 'SURFACE'
    else if (node.nodeType === Node.ELEMENT_NODE && surface) {
      const el = node as Element
      container = `${el.tagName}#${[...surface.querySelectorAll(el.tagName)].indexOf(el)}`
    }
    const length =
      node.nodeType === Node.ELEMENT_NODE ? node.childNodes.length : -1
    return {
      caret: range.toString() === '',
      container,
      offset: range.startOffset,
      length,
    }
  }) as Promise<{
    caret: boolean
    container: string
    offset: number
    length?: number
  }>

type Key = 'Control+c' | 'Control+x'

/** How long `press` waits for the before-event record of an ordinary gesture. */
const PRESS_WAIT_MS = 10_000
// The latency rows wait longer. After a resolved copy at x16, the selection bubble's held index
// builds keep the webview's main thread busy for about 12 s (measured in VS Code), and the poll's
// evaluate queues behind that task, so a recorded before-event could not be read within 10 s.
const LATENCY_PRESS_WAIT_MS = 60_000

/**
 * Press `key` with the sentinel on the clipboard; return the before-event the webview saw. It waits
 * for that before-event itself, because a declined gesture leaves the clipboard and the host
 * unchanged, so neither of them could tell a declined gesture from a missed shortcut.
 */
async function press(
  frame: Frame,
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: Evaluate,
  key: Key,
  wait = PRESS_WAIT_MS,
): Promise<Seen> {
  await writeClip(evaluateInVSCode, SENTINEL)
  // Let the caret placement's own work finish before the gesture is measured.
  await settle(frame, 500)
  await takeSeen(frame)
  await markKey(frame)
  await workbox.keyboard.press(key)
  const type = key === 'Control+c' ? 'beforecopy' : 'beforecut'
  let seen: Seen | undefined
  await expect
    .poll(
      async () => {
        const got = await frame
          .locator('body')
          .evaluate(
            (_el, t) =>
              (window as unknown as { __guardSeen: Seen[] }).__guardSeen.find(
                (s) => s.type === t,
              ) ?? null,
            type,
          )
        seen = got ?? undefined
        return got !== null
      },
      { message: `${type} reached the webview`, timeout: wait },
    )
    .toBe(true)
  return seen as Seen
}

/** Collapsed Copy with the caret already placed: the clipboard after it lands. */
async function copyLanded(
  frame: Frame,
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: Evaluate,
): Promise<{ clip: string; seen: Seen }> {
  const seen = await press(frame, workbox, evaluateInVSCode, 'Control+c')
  await expect
    .poll(() => readClip(evaluateInVSCode), { message: 'the copy landed' })
    .not.toBe(SENTINEL)
  return { clip: await readClip(evaluateInVSCode), seen }
}

/** Collapsed Cut with the caret already placed: the clipboard and the host after it lands. */
async function cutLanded(
  frame: Frame,
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: Evaluate,
  file: string,
  opening: string,
): Promise<{ clip: string; host: string; seen: Seen }> {
  const seen = await press(frame, workbox, evaluateInVSCode, 'Control+x')
  await expect
    .poll(() => readClip(evaluateInVSCode), { message: 'the cut copied' })
    .not.toBe(SENTINEL)
  await expect
    .poll(() => docText(evaluateInVSCode, file), {
      message: 'the cut reached the host',
    })
    .not.toBe(opening)
  // The cut's input settles into one host edit; let a trailing debounce land before reading.
  await settle(frame, 500)
  return {
    clip: await readClip(evaluateInVSCode),
    host: await docText(evaluateInVSCode, file),
    seen,
  }
}

/** A declined gesture: the sentinel and the document stay after a negative-assertion wait. */
async function expectKept(
  frame: Frame,
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: Evaluate,
  file: string,
  opening: string,
  key: Key,
  at: { container: string; offset: number },
  label: string,
): Promise<void> {
  const seen = await press(frame, workbox, evaluateInVSCode, key)
  expect
    .soft(
      { caret: seen.caret, container: seen.container, offset: seen.offset },
      `${label} ${key}: the before-event saw the intended collapsed caret`,
    )
    .toEqual({ caret: true, ...at })
  await settle(frame, DECLINE_WAIT_MS)
  expect
    .soft(
      await readClip(evaluateInVSCode),
      `${label} ${key}: the clipboard keeps the sentinel`,
    )
    .toBe(SENTINEL)
  expect
    .soft(
      await docText(evaluateInVSCode, file),
      `${label} ${key}: the document is unchanged`,
    )
    .toBe(opening)
}

interface Controls {
  copy: string
  cutClip: string
  cutHost: string
}

/** The text-caret control for `needle`: Copy and Cut each in a fresh document. */
async function control(
  evaluateInVSCode: Evaluate,
  workbox: import('@playwright/test').Page,
  baseDir: string,
  mode: Mode,
  needle: string,
): Promise<Controls> {
  const a = await openIn(
    evaluateInVSCode,
    workbox,
    baseDir,
    mode,
    `control-copy-${mode}`,
    FIXTURE,
  )
  await textCaret(a.frame, mode, needle, 2)
  const copied = await copyLanded(a.frame, workbox, evaluateInVSCode)
  expect
    .soft(await docText(evaluateInVSCode, a.file), 'control copy edits nothing')
    .toBe(a.opening)
  const b = await openIn(
    evaluateInVSCode,
    workbox,
    baseDir,
    mode,
    `control-cut-${mode}`,
    FIXTURE,
  )
  await textCaret(b.frame, mode, needle, 2)
  const cut = await cutLanded(
    b.frame,
    workbox,
    evaluateInVSCode,
    b.file,
    b.opening,
  )
  return { copy: copied.clip, cutClip: cut.clip, cutHost: cut.host }
}

/** The arrow landing: text caret in `from`, then `arrow` across the rule into the list. */
async function arrowLanding(
  frame: Frame,
  workbox: import('@playwright/test').Page,
  mode: Mode,
  from: string,
  at: number,
  arrow: 'ArrowDown' | 'ArrowUp',
): Promise<void> {
  await textCaret(frame, mode, from, at)
  await workbox.keyboard.press(arrow)
  await settle(frame, 300)
}

/** T1 (and T2 in IR): the one-sided list edge after an arrow move resolves like a text caret. */
async function edgeCase(
  evaluateInVSCode: Evaluate,
  workbox: import('@playwright/test').Page,
  baseDir: string,
  mode: Mode,
  edge: {
    label: string
    from: string
    at: number
    arrow: 'ArrowDown' | 'ArrowUp'
    line: string
    end: boolean
  },
): Promise<void> {
  const ctl = await control(evaluateInVSCode, workbox, baseDir, mode, edge.line)
  expect
    .soft(ctl.copy, `${edge.label}: the control copies its line`)
    .toContain(edge.line)
  for (const key of ['Control+c', 'Control+x'] as const) {
    const doc = await openIn(
      evaluateInVSCode,
      workbox,
      baseDir,
      mode,
      `${edge.label}-${key === 'Control+c' ? 'copy' : 'cut'}-${mode}`,
      FIXTURE,
    )
    await arrowLanding(doc.frame, workbox, mode, edge.from, edge.at, edge.arrow)
    const live = await liveCaret(doc.frame)
    // The arrow move must leave the element caret this task guards; a text point would make the
    // rest of this case a control, not a regression test.
    expect(
      {
        caret: live.caret,
        container: live.container,
        atEdge: edge.end ? live.offset === live.length : live.offset === 0,
      },
      `${edge.label}: the arrow move left a collapsed caret at the list edge`,
    ).toEqual({ caret: true, container: 'UL#1', atEdge: true })
    if (key === 'Control+c') {
      const { clip, seen } = await copyLanded(
        doc.frame,
        workbox,
        evaluateInVSCode,
      )
      expect
        .soft(seen.container, `${edge.label}: beforecopy saw the list edge`)
        .toBe('UL#1')
      expect
        .soft(clip, `${edge.label}: Ctrl+C copies exactly the control's line`)
        .toBe(ctl.copy)
      expect
        .soft(await docText(evaluateInVSCode, doc.file), 'copy edits nothing')
        .toBe(doc.opening)
    } else {
      const { clip, host, seen } = await cutLanded(
        doc.frame,
        workbox,
        evaluateInVSCode,
        doc.file,
        doc.opening,
      )
      expect
        .soft(seen.container, `${edge.label}: beforecut saw the list edge`)
        .toBe('UL#1')
      expect
        .soft(clip, `${edge.label}: Ctrl+X copies exactly the control's line`)
        .toBe(ctl.cutClip)
      expect
        .soft(host, `${edge.label}: Ctrl+X leaves exactly the control's host`)
        .toBe(ctl.cutHost)
    }
  }
}

/** T3 and T4: ambiguous element points keep the clipboard and the document. */
async function ambiguousCases(
  evaluateInVSCode: Evaluate,
  workbox: import('@playwright/test').Page,
  baseDir: string,
  mode: Mode,
): Promise<void> {
  const points: Array<{ label: string; point: ElementPoint }> = [
    { label: 'UL,1', point: { kind: 'ul', nth: 0, offset: 1 } },
    {
      label: 'PRE,n before the first list',
      point: { kind: 'surface', tag: 'ul', nth: 0 },
    },
    {
      label: 'PRE,n before the second rule',
      point: { kind: 'surface', tag: 'hr', nth: 1 },
    },
  ]
  for (const { label, point } of points)
    for (const key of ['Control+c', 'Control+x'] as const) {
      const doc = await openIn(
        evaluateInVSCode,
        workbox,
        baseDir,
        mode,
        `ambiguous-${mode}`,
        FIXTURE,
      )
      const at = await elementCaret(doc.frame, mode, point)
      await expectKept(
        doc.frame,
        workbox,
        evaluateInVSCode,
        doc.file,
        doc.opening,
        key,
        at,
        `${mode} ${label}`,
      )
    }
}

/** T5: a text caret copies its line; an explicit selection copies and cuts exactly itself. */
async function renderedControls(
  evaluateInVSCode: Evaluate,
  workbox: import('@playwright/test').Page,
  baseDir: string,
  mode: Mode,
): Promise<void> {
  const a = await openIn(
    evaluateInVSCode,
    workbox,
    baseDir,
    mode,
    `text-caret-${mode}`,
    FIXTURE,
  )
  await textCaret(a.frame, mode, 'ALPHA', 2)
  const { clip, seen } = await copyLanded(a.frame, workbox, evaluateInVSCode)
  expect
    .soft(seen.container, 'the text-caret control saw a text point')
    .toBe('TEXT')
  expect
    .soft(clip, `${mode}: a text caret copies its paragraph line`)
    .toBe('Head paragraph ALPHA.')

  for (const key of ['Control+c', 'Control+x'] as const) {
    const doc = await openIn(
      evaluateInVSCode,
      workbox,
      baseDir,
      mode,
      `explicit-${mode}`,
      FIXTURE,
    )
    await textCaret(doc.frame, mode, 'ALPHA', 0)
    // A real Shift+Arrow selection: a scripted selection write is not a gesture, and the caret
    // authority restores its own caret over it.
    for (let i = 0; i < 'ALPHA'.length; i++)
      await workbox.keyboard.press('Shift+ArrowRight')
    await settle(doc.frame, 200)
    expect(
      await doc.frame
        .locator('body')
        .evaluate(() => getSelection()?.toString() ?? ''),
      'the explicit selection is ALPHA',
    ).toBe('ALPHA')
    if (key === 'Control+c') {
      const copied = await copyLanded(doc.frame, workbox, evaluateInVSCode)
      expect
        .soft(copied.clip, `${mode}: explicit Ctrl+C copies the selection`)
        .toBe('ALPHA')
      expect
        .soft(await docText(evaluateInVSCode, doc.file), 'copy edits nothing')
        .toBe(doc.opening)
    } else {
      const cut = await cutLanded(
        doc.frame,
        workbox,
        evaluateInVSCode,
        doc.file,
        doc.opening,
      )
      expect
        .soft(cut.clip, `${mode}: explicit Ctrl+X copies the selection`)
        .toBe('ALPHA')
      expect
        .soft(
          cut.host,
          `${mode}: explicit Ctrl+X removes exactly the selection`,
        )
        .toBe(doc.opening.replace('Head paragraph ALPHA.', 'Head paragraph .'))
    }
  }
}

for (const mode of ['ir', 'wysiwyg'] as const)
  test(`${mode}: collapsed Copy and Cut take one line block and keep the clipboard at an ambiguous point`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    await edgeCase(evaluateInVSCode, workbox, baseDir, mode, {
      label: 'ArrowDown over a rule',
      from: 'KILO',
      at: 'KILO'.length,
      arrow: 'ArrowDown',
      line: 'item three DELTA',
      end: false,
    })
    if (mode === 'ir')
      await edgeCase(evaluateInVSCode, workbox, baseDir, mode, {
        label: 'ArrowUp over a rule',
        from: 'Tail paragraph',
        at: 0,
        arrow: 'ArrowUp',
        line: 'item four ECHO',
        end: true,
      })
    await ambiguousCases(evaluateInVSCode, workbox, baseDir, mode)
    await renderedControls(evaluateInVSCode, workbox, baseDir, mode)
  })

test('sv: collapsed Copy and Cut still take exactly the source line', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const a = await openIn(
    evaluateInVSCode,
    workbox,
    baseDir,
    'sv',
    'sv-copy',
    SV_FIXTURE,
  )
  expect(a.opening, 'the Source fixture opens byte-stable').toBe(SV_FIXTURE)
  await textCaret(a.frame, 'sv', 'BRAVO', 2)
  const copied = await copyLanded(a.frame, workbox, evaluateInVSCode)
  expect
    .soft(copied.clip, 'sv Ctrl+C copies the source line')
    .toBe('Bravo line BRAVO\n')
  expect
    .soft(await docText(evaluateInVSCode, a.file), 'copy edits nothing')
    .toBe(SV_FIXTURE)

  const b = await openIn(
    evaluateInVSCode,
    workbox,
    baseDir,
    'sv',
    'sv-cut',
    SV_FIXTURE,
  )
  await textCaret(b.frame, 'sv', 'BRAVO', 2)
  const cut = await cutLanded(
    b.frame,
    workbox,
    evaluateInVSCode,
    b.file,
    b.opening,
  )
  expect
    .soft(cut.clip, 'sv Ctrl+X copies the source line')
    .toBe('Bravo line BRAVO\n')
  expect
    .soft(cut.host, 'sv Ctrl+X removes exactly the source line')
    .toBe('Alpha line ALPHA\nCharlie line CHARLIE\n')
})

/** The lines of `before` missing from `after`, and the lines of `after` new to it. */
function lineDiff(
  before: string,
  after: string,
): { gone: string[]; added: string[] } {
  const count = (text: string) => {
    const map = new Map<string, number>()
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1)
    return map
  }
  const b = count(before)
  const a = count(after)
  const gone: string[] = []
  const added: string[] = []
  for (const [line, n] of b)
    for (let i = a.get(line) ?? 0; i < n; i++) gone.push(line)
  for (const [line, n] of a)
    for (let i = b.get(line) ?? 0; i < n; i++) added.push(line)
  return { gone, added }
}

interface LatencyRow {
  factor: number
  row: string
  gated: boolean
  beforeEventMs: number
  longTaskCount: number
  longTaskMaxMs: number
  eventCount: number
  eventMaxMs: number
}

test('the collapsed Copy and Cut guard stays within 50 ms at x1, x4 and x16', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(1_800_000)
  const rows: LatencyRow[] = []
  for (const factor of [1, 4, 16] as const) {
    const doc = await openIn(
      evaluateInVSCode,
      workbox,
      baseDir,
      'ir',
      `latency-x${factor}`,
      tableHeavyMarkdown(factor),
    )
    let host = doc.opening

    /** One measured gesture: the 3 s after the key, gated unless it is the text-caret control. */
    const measure = async (
      row: string,
      gated: boolean,
      key: Key,
      place: () => Promise<unknown>,
      landed: () => Promise<void>,
    ) => {
      await place()
      await takeSeen(doc.frame)
      const seen = await press(
        doc.frame,
        workbox,
        evaluateInVSCode,
        key,
        LATENCY_PRESS_WAIT_MS,
      )
      await landed()
      await settle(doc.frame, 3000)
      const perf = await takeSeen(doc.frame)
      const beforeEventMs =
        seen.end < 0 ? Number.POSITIVE_INFINITY : seen.end - seen.start
      const result: LatencyRow = {
        factor,
        row,
        gated,
        beforeEventMs: Math.round(beforeEventMs * 10) / 10,
        longTaskCount: perf.long.length,
        longTaskMaxMs: Math.round(Math.max(0, ...perf.long)),
        eventCount: perf.events.length,
        eventMaxMs: Math.round(Math.max(0, ...perf.events)),
      }
      rows.push(result)
      if (!gated) return
      const label = `x${factor} ${row}`
      expect
        .soft(result.beforeEventMs, `${label}: before-event span`)
        .toBeLessThan(BUDGET_MS)
      expect
        .soft(result.longTaskMaxMs, `${label}: longest main-thread task`)
        .toBeLessThan(BUDGET_MS)
      expect
        .soft(result.eventMaxMs, `${label}: longest Event Timing entry`)
        .toBeLessThan(BUDGET_MS)
    }

    const declined = async (key: Key) => {
      await settle(doc.frame, DECLINE_WAIT_MS)
      expect
        .soft(
          await readClip(evaluateInVSCode),
          `x${factor} declined ${key}: sentinel`,
        )
        .toBe(SENTINEL)
      expect
        .soft(
          await docText(evaluateInVSCode, doc.file),
          `x${factor} declined ${key}: host`,
        )
        .toBe(host)
    }
    const copied = (line: string) => async () => {
      await expect.poll(() => readClip(evaluateInVSCode)).not.toBe(SENTINEL)
      expect
        .soft(await readClip(evaluateInVSCode), `x${factor} copy of ${line}`)
        .toBe(line)
      expect
        .soft(
          await docText(evaluateInVSCode, doc.file),
          `x${factor} copy edits nothing`,
        )
        .toBe(host)
    }
    const cutOne = (line: string) => async () => {
      const previous = host
      await expect
        .poll(() => docText(evaluateInVSCode, doc.file))
        .not.toBe(previous)
      await settle(doc.frame, 500)
      host = await docText(evaluateInVSCode, doc.file)
      expect
        .soft(await readClip(evaluateInVSCode), `x${factor} cut of ${line}`)
        .toBe(line)
      const diff = lineDiff(previous, host)
      expect
        .soft(
          diff.gone,
          `x${factor} cut of ${line}: only that line left the host`,
        )
        .toEqual([`- ${line}`])
      expect
        .soft(
          diff.added.every((l) => l === '-' || l === '- ' || l === ''),
          `x${factor} cut of ${line}: nothing else changed`,
        )
        .toBe(true)
    }

    const ul = (offset: number) => () =>
      elementCaret(doc.frame, 'ir', { kind: 'ul', nth: 0, offset })
    const text = (needle: string) => () => textCaret(doc.frame, 'ir', needle, 2)

    await measure('declined copy UL,1', true, 'Control+c', ul(1), () =>
      declined('Control+c'),
    )
    await measure('declined cut UL,1', true, 'Control+x', ul(1), () =>
      declined('Control+x'),
    )
    await measure(
      'resolved copy UL,0',
      true,
      'Control+c',
      ul(0),
      copied('list item 1'),
    )
    await measure(
      'control copy text caret',
      false,
      'Control+c',
      text('list item 1'),
      copied('list item 1'),
    )
    await measure(
      'resolved cut UL,0',
      true,
      'Control+x',
      ul(0),
      cutOne('list item 1'),
    )
    await measure(
      'control cut text caret',
      false,
      'Control+x',
      text('list item 3'),
      cutOne('list item 3'),
    )
  }
  // Operation names and numbers only, never document text.
  console.log(`CLIPBOARD-GUARD-LATENCY ${JSON.stringify(rows)}`)
})
