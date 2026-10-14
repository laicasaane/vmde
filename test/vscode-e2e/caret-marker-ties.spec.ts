import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
} from './webview-helpers'

// Task 609 (S4) — real-VS-Code proof that a caret at a marker/content tie is restored to the
// visible content start, that editable marker source (the fence info line) stays editable, and that
// a Details toggle's own selection is not pulled back by a live caret intent.
//
// Keyboard input is OS-level (XTEST): run under the isolated Xvfb + Openbox shell from
// docs/os-keyboard-testing-setup.md with VMDE_XTEST=1. Pointer clicks only focus the webview and
// never follow the restore under test (a pointer gesture invalidates a live intent).
// Each test records the native writer (the Undo checkpoint call stack), the caret requests it made,
// the selection before and after the restore, the typing result and the host bytes to
// tmp/task609-checks/s4/.

const HEADING_DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n'
const HEADING_TYPED = HEADING_DOC.replace('# Probe', '# xProbe')
const PARAGRAPH_DOC = 'alpha\n'
const FENCED_TYPED = '```\nxalpha\n```\n'
const FENCE_INFO_DOC = '```js\nalpha\n```\n'
const FENCE_INFO_TYPED = '```jsxy\nalpha\n```\n'
const DETAILS_BODY = 'Toolbar body **exact**.\n\n- toolbar item'
const DETAILS_DOC = `${DETAILS_BODY}\n\nTail.\n`
const DETAILS_WRAPPED = `<details>\n<summary>Details</summary>\n\n${DETAILS_BODY}\n\n</details>\n\nTail.\n`
const OUTPUT = path.resolve(__dirname, '../../tmp/task609-checks/s4')

type Mode = 'ir' | 'wysiwyg'
type Frame = Awaited<ReturnType<typeof reopenVmdeFixture>>
type HostEvaluator = Parameters<typeof docText>[0]

interface Caret {
  collapsed: boolean
  text: string | null
  offset: number
  isRoot: boolean
  inMarker: boolean
  inHeading: boolean
  inCode: boolean
  // Characters from the start of the nearest `[data-block]` to the caret (-1 outside a block): the
  // flat block offset that the caret capture records, so a tie is visible whatever the DOM node.
  blockOffset: number
  // False when the caret's element has no layout box (for example a `display: none` source).
  painted: boolean
  selected: string
  anchorHtml: string
}
interface TraceEvent {
  kind: 'checkpoint' | 'caretRequest'
  t: number
  stackLength: number
  // Checkpoint: the selection at capture time. Request: the intent coordinates.
  caret?: Caret
  intent?: unknown
  writer?: string[]
}
interface Snapshot extends Caret {
  mode: string
  focused: boolean
  value: string
  delivered: string[]
  undoStackLength: number
  trace: TraceEvent[]
  traceLive: boolean
}

const frames = (frame: Frame, count = 2) =>
  frame.locator('body').evaluate(
    (_body, n) =>
      new Promise<void>((resolve) => {
        let left = (n as number) * 2
        const step = () =>
          --left <= 0 ? resolve() : requestAnimationFrame(step)
        requestAnimationFrame(step)
      }),
    count,
  )

// Installed once per opened document: wraps the live Undo checkpoint and the caret bridge so a
// native checkpoint's caller and the caret request it produces are recorded without changing them.
async function installTrace(frame: Frame) {
  await frame.locator('body').evaluate(() => {
    const target = window as any
    const inner = target.vditor?.vditor
    if (!inner?.undo || typeof inner.undo.addToUndoStack !== 'function')
      throw new Error('Task 609 cannot trace the live Undo instance')
    if (typeof target.__vmdeRequestCaret !== 'function')
      throw new Error('Task 609 cannot trace the live caret bridge')
    const rootOf = () => inner[inner.currentMode].element as HTMLElement
    target.__task609Describe = (): Caret => {
      const selection = getSelection()
      const node = selection?.anchorNode ?? null
      const element = node instanceof Element ? node : node?.parentElement
      return {
        collapsed: selection?.isCollapsed ?? true,
        text: node instanceof Text ? node.data : null,
        offset: selection?.anchorOffset ?? -1,
        isRoot: node === rootOf(),
        inMarker: !!element?.closest('.vditor-ir__marker'),
        inHeading: !!element?.closest('h1,h2,h3,h4,h5,h6'),
        inCode: !!element?.closest('code'),
        blockOffset: (() => {
          const block = element?.closest('[data-block]')
          if (!block || !node) return -1
          const span = document.createRange()
          span.setStart(block, 0)
          span.setEnd(node, selection?.anchorOffset ?? 0)
          return span.toString().length
        })(),
        painted: !!element && element.getClientRects().length > 0,
        selected: selection?.toString() ?? '',
        anchorHtml:
          (element?.closest('[data-block]') ?? element)?.outerHTML.slice(
            0,
            1200,
          ) ?? '',
      }
    }
    const trace: TraceEvent[] = []
    const stackLength = () =>
      inner.undo[inner.currentMode]?.undoStack.length ?? 0
    target.__task609Trace = trace
    target.__task609Input = []
    const originalCheckpoint = inner.undo.addToUndoStack.bind(inner.undo)
    inner.undo.addToUndoStack = (...args: unknown[]) => {
      // Function names only: the caller chain identifies the native writer.
      const writer = (new Error().stack ?? '')
        .split('\n')
        .slice(2, 8)
        .map((line) =>
          line
            .trim()
            .replace(/^at\s+/, '')
            .replace(/\(?\S*\/([^/\s]+?)(?:\?\S*?)?(:\d+:\d+)\)?$/, '$1$2'),
        )
      trace.push({
        kind: 'checkpoint',
        t: performance.now(),
        stackLength: stackLength(),
        caret: target.__task609Describe(),
        writer,
      })
      return originalCheckpoint(...args)
    }
    target.__task609WrappedUndo = inner.undo.addToUndoStack
    target.__task609UndoOwner = inner.undo
    const originalCaret = target.__vmdeRequestCaret
    const wrappedCaret = (intent: unknown) => {
      trace.push({
        kind: 'caretRequest',
        t: performance.now(),
        stackLength: stackLength(),
        // Node references are transient and non-JSON; keep the coordinates only.
        intent:
          intent == null
            ? null
            : JSON.parse(
                JSON.stringify(intent, (_key, value) =>
                  value instanceof Node ? { nodeName: value.nodeName } : value,
                ),
              ),
      })
      return originalCaret(intent)
    }
    target.__task609WrappedCaret = wrappedCaret
    target.__vmdeRequestCaret = wrappedCaret
    document.addEventListener(
      'beforeinput',
      (event) => {
        if (event.inputType === 'insertText' && event.data)
          target.__task609Input.push(event.data)
      },
      true,
    )
  })
}

const snapshot = (frame: Frame) =>
  frame.locator('body').evaluate((): Snapshot => {
    const target = window as any
    const inner = target.vditor.vditor
    const root = inner[inner.currentMode].element as HTMLElement
    return {
      ...target.__task609Describe(),
      mode: inner.currentMode,
      focused: document.activeElement === root,
      value: target.vditor.getValue(),
      delivered: [...target.__task609Input],
      undoStackLength: inner.undo[inner.currentMode]?.undoStack.length ?? 0,
      trace: [...target.__task609Trace],
      traceLive:
        inner.undo === target.__task609UndoOwner &&
        inner.undo.addToUndoStack === target.__task609WrappedUndo &&
        target.__vmdeRequestCaret === target.__task609WrappedCaret,
    }
  })

const checkpoints = (state: Snapshot) =>
  state.trace.filter((event) => event.kind === 'checkpoint')

// Places a collapsed caret programmatically `offset` characters into the first editable text node
// that contains `text` within `container` (a deterministic setup position, as other caret specs use).
async function placeCaret(
  frame: Frame,
  container: string,
  text: string,
  offset: number,
) {
  await frame.locator('body').evaluate(
    (_body, args) => {
      const [selector, data, at] = args as [string, string, number]
      const inner = (window as any).vditor.vditor
      const root = inner[inner.currentMode].element as HTMLElement
      const scope = root.querySelector(selector)
      if (!scope) throw new Error(`Task 609 container ${selector} missing`)
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        // The info line's text node carries a leading zero-width space, so match by substring.
        const index = (node as Text).data.indexOf(data)
        if (index < 0 || node.parentElement?.closest('[data-render]')) continue
        const range = document.createRange()
        range.setStart(node, index + at)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        root.focus({ preventScroll: true })
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      throw new Error(
        `Task 609 text ${data} missing under ${selector}: ${root.innerHTML.slice(0, 1500)}`,
      )
    },
    [container, text, offset] as [string, string, number],
  )
}

function recorder(name: string) {
  const observations: Record<string, unknown>[] = []
  const persist = () => {
    mkdirSync(OUTPUT, { recursive: true })
    writeFileSync(
      path.join(OUTPUT, `${name}.json`),
      JSON.stringify(observations, null, 2),
    )
  }
  return {
    record(step: string, data: object) {
      observations.push({ step, ...data })
      persist()
    },
    async attach() {
      persist()
      await test.info().attach(name, {
        body: JSON.stringify(observations, null, 2),
        contentType: 'application/json',
      })
    },
  }
}

function session(evaluate: HostEvaluator, workbox: Page, baseDir: string) {
  let previous: string | undefined
  let serial = 0
  return {
    // Opens `doc` in `mode`, installs the trace and waits for the opening Undo checkpoint, so a
    // later checkpoint is attributable to the step under test.
    async open(doc: string, mode: Mode) {
      if (previous) {
        // Save the previous disposable document so closing the editors cannot raise a dirty-file
        // prompt between the two documents of one test.
        await evaluate(
          async (vscode: typeof import('vscode'), [file]: string[]) => {
            await vscode.workspace.textDocuments
              .find((item) => item.uri.fsPath === file)
              ?.save()
          },
          [previous],
        )
      }
      const file = path.join(baseDir, `task609-${++serial}.md`)
      writeFileSync(file, doc)
      previous = file
      // The mode is remembered across documents; a SV or WYSIWYG remembered mode would never show
      // the IR selector, so open without waiting for it.
      const frame = await reopenVmdeFixture(
        evaluate,
        workbox,
        file,
        60_000,
        '.vditor',
        false,
      )
      const opened = await waitForE2EReadiness(
        frame,
        (s) => s.routerReady && s.editorEpoch > 0 && s.mode !== null,
        { message: 'Task 609 editor ready' },
      )
      if (opened.mode !== mode) {
        await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
        await frame.locator(`button[data-mode="${mode}"]`).click()
        await waitForE2EReadiness(
          frame,
          (s) => s.routerReady && s.editorEpoch > 0 && s.mode === mode,
          { message: `Task 609 ${mode} ready` },
        )
      }
      await installTrace(frame)
      await expect
        .poll(
          async () => {
            const state = await snapshot(frame)
            if (!state.traceLive || state.mode !== mode)
              throw new Error(`Task 609 trace detached from ${mode}`)
            return state.undoStackLength
          },
          { timeout: 10_000, message: 'Task 609 opening Undo checkpoint' },
        )
        .toBeGreaterThan(0)
      expect(await docText(evaluate, file)).toBe(doc)
      return { frame, file }
    },
  }
}

interface Context {
  evaluate: HostEvaluator
  workbox: Page
  baseDir: string
  input: Awaited<ReturnType<typeof createXtestInput>>
  report: ReturnType<typeof recorder>
  run: ReturnType<typeof session>
}

// Types Q at the heading content start, then Backspace removes it: the Backspace input arms the
// debounced Undo checkpoint with the caret back at the content start, which is the tie under test
// (block offset 2 is both the end of the hidden `# ` marker and the start of `Probe`).
async function headingCheckpointRoute(mode: Mode, ctx: Context) {
  const { evaluate, input, report } = ctx
  // IR: offset 2 is the end of the hidden `# ` and the start of `Probe`. WYSIWYG has no marker text,
  // so the content start is offset 0 and no tie exists: the route proves the restore is unchanged.
  const tieOffset = mode === 'ir' ? 2 : 0
  const { frame, file } = await ctx.run.open(HEADING_DOC, mode)
  // Focus the editor with a pointer click on another block, then set the caret programmatically.
  await frame.locator(`.vditor-${mode} p`).filter({ hasText: 'Echo' }).click()
  await placeCaret(frame, 'h1', 'Probe', 0)
  await frames(frame)
  let state = await snapshot(frame)
  expect(state).toMatchObject({
    text: 'Probe',
    offset: 0,
    inMarker: false,
    focused: true,
  })

  await input.type('Q')
  await frames(frame)
  await expect
    .poll(async () => (await snapshot(frame)).delivered)
    .toEqual(['Q'])
  await expect
    .poll(async () => (await snapshot(frame)).value)
    .toBe(HEADING_DOC.replace('# Probe', '# QProbe'))
  const afterQ = (await snapshot(frame)).trace.length
  report.record(`${mode}: typed Q at Probe@0`, { ...(await snapshot(frame)) })

  // The checkpoint after Q must finish before Backspace so the next one is the tie checkpoint.
  await expect
    .poll(async () => checkpoints(await snapshot(frame)).length, {
      timeout: 5_000,
      message: 'Task 609 checkpoint after Q',
    })
    .toBeGreaterThan(checkpoints(state).length)
  const checkpointsBefore = checkpoints(await snapshot(frame)).length
  await input.key('BackSpace')
  await frames(frame)
  await expect.poll(async () => (await snapshot(frame)).value).toBe(HEADING_DOC)
  state = await snapshot(frame)
  report.record(`${mode}: Backspace removed Q (before the tie checkpoint)`, {
    ...state,
    eventsSinceQ: state.trace.slice(afterQ),
  })
  expect(checkpoints(state).length, 'Backspace checkpoint not yet taken').toBe(
    checkpointsBefore,
  )
  // The browser leaves the caret at an element position after the Backspace; what matters is the
  // flat block offset 2, shared by the end of the hidden `# ` and the start of `Probe`.
  expect(state).toMatchObject({
    blockOffset: tieOffset,
    inMarker: false,
    inHeading: true,
  })

  await expect
    .poll(async () => checkpoints(await snapshot(frame)).length, {
      timeout: 5_000,
      message: 'Task 609 debounced checkpoint with the caret at the tie',
    })
    .toBe(checkpointsBefore + 1)
  await frames(frame)
  state = await snapshot(frame)
  const tie = checkpoints(state).at(-1)!
  report.record(`${mode}: tie checkpoint restored`, {
    ...state,
    writer: tie.writer,
    captureCaret: tie.caret,
    host: await docText(evaluate, file),
  })
  // Acceptance 1: the restore is at the visible content start, in the heading, outside the marker,
  // and it changed no Markdown.
  expect(tie.caret).toMatchObject({ blockOffset: tieOffset, inMarker: false })
  expect(state).toMatchObject({
    text: 'Probe',
    offset: 0,
    inMarker: false,
    inHeading: true,
    focused: true,
  })
  expect(state.value).toBe(HEADING_DOC)
  expect(await docText(evaluate, file)).toBe(HEADING_DOC)
  // A live caret intent re-asserts for several frames; the landing must hold.
  await frames(frame, 20)
  state = await snapshot(frame)
  expect(state).toMatchObject({ text: 'Probe', offset: 0, inMarker: false })

  await input.type('x')
  await frames(frame)
  await expect
    .poll(async () => (await snapshot(frame)).delivered)
    .toEqual(['Q', 'x'])
  await expect
    .poll(async () => (await snapshot(frame)).value)
    .toBe(HEADING_TYPED)
  await expect.poll(() => docText(evaluate, file)).toBe(HEADING_TYPED)
  report.record(`${mode}: typed x after the restore`, {
    ...(await snapshot(frame)),
    host: await docText(evaluate, file),
  })
}

// Turn Into a Code Fence through the native QuickPick, then type with XTEST and no pointer gesture
// in between: the apply path reduces the content start to a flat offset that ties with the fence
// info line, and the restore must choose the code content.
async function turnIntoFenceRoute(mode: Mode, ctx: Context) {
  const { evaluate, workbox, input, report } = ctx
  const { frame, file } = await ctx.run.open(PARAGRAPH_DOC, mode)
  // Pointer click focuses the webview; the caret then goes to the paragraph start programmatically.
  await frame.locator(`.vditor-${mode} p`).filter({ hasText: 'alpha' }).click()
  await placeCaret(frame, 'p', 'alpha', 0)
  await frames(frame)
  const picker = workbox.locator('.quick-input-widget input').first()
  await evaluate(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('vmde.turnInto')
    },
    [''],
  )
  await expect(picker).toBeVisible()
  await picker.fill('Code Fence')
  await picker.press('Enter')
  await expect(picker).toBeHidden()
  // A Code Fence turns the paragraph into literal code, which the native flow confirms first.
  const dialog = workbox.getByRole('dialog').filter({ hasText: 'literal code' })
  await expect(dialog).toBeVisible()
  expect(await docText(evaluate, file)).toBe(PARAGRAPH_DOC)
  await dialog.getByRole('button', { name: 'Turn Into' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(() => docText(evaluate, file)).toBe('```\nalpha\n```\n')
  await frames(frame)
  let state = await snapshot(frame)
  report.record(`${mode}: Turn Into applied`, {
    ...state,
    host: await docText(evaluate, file),
  })
  // Acceptance 1: the caret is at the start of the code content, not in the fence info line.
  expect(state).toMatchObject({ inCode: true, offset: 0, focused: true })
  expect(state.text?.startsWith('alpha')).toBe(true)
  await frames(frame, 20)
  state = await snapshot(frame)
  expect(state).toMatchObject({ inCode: true, offset: 0 })
  expect(state.text?.startsWith('alpha')).toBe(true)
  if (mode === 'ir') expect(state.painted).toBe(true)

  await input.type('x')
  await frames(frame)
  await expect
    .poll(async () => (await snapshot(frame)).delivered)
    .toEqual(['x'])
  if (mode === 'wysiwyg') {
    // Recorded, not asserted: WYSIWYG has no marker text nodes, so the tie rule does not apply
    // there; the measured outcome (the restore lands in the code block's hidden source, and typing
    // does not reach the document) is reported as a separate finding.
    await frames(frame, 20)
    report.record('wysiwyg: typed x after Turn Into (outcome recorded)', {
      ...(await snapshot(frame)),
      host: await docText(evaluate, file),
    })
    return
  }
  await expect
    .poll(async () => (await snapshot(frame)).value)
    .toBe(FENCED_TYPED)
  await expect.poll(() => docText(evaluate, file)).toBe(FENCED_TYPED)
  report.record(`${mode}: typed x after Turn Into`, {
    ...(await snapshot(frame)),
    host: await docText(evaluate, file),
  })
}

function xtestTest(
  title: string,
  body: (ctx: Context) => Promise<void>,
  timeout = 180_000,
) {
  test(title, async ({ electronApp, workbox, evaluateInVSCode, baseDir }) => {
    test.skip(
      process.env.VMDE_XTEST !== '1',
      'Requires isolated Xvfb + Openbox and VMDE_XTEST=1',
    )
    test.setTimeout(timeout)
    const evaluate = evaluateInVSCode as HostEvaluator
    const report = recorder(
      title
        .replace(/[^a-z0-9]+/gi, '-')
        .toLowerCase()
        .slice(0, 60),
    )
    try {
      await body({
        evaluate,
        workbox,
        baseDir,
        input: await createXtestInput(electronApp, workbox),
        report,
        run: session(evaluate, workbox, baseDir),
      })
    } finally {
      await report.attach()
    }
  })
}

// Acceptance 1 (IR): the debounced Undo checkpoint at the heading content start.
xtestTest(
  'IR heading: the Undo checkpoint restore keeps the caret at the content start',
  (ctx) => headingCheckpointRoute('ir', ctx),
)

// Acceptance 1 (IR): Turn Into a Code Fence lands the caret in the code content.
xtestTest(
  'IR Turn Into Code Fence: the caret lands in the code content',
  (ctx) => turnIntoFenceRoute('ir', ctx),
)

// Acceptance 2 (markers stay editable): typing in the fence info line is typing into marker source,
// so an Undo checkpoint after it must leave the caret at the end of the info text.
xtestTest('IR fence info: typing survives the Undo checkpoint', async (ctx) => {
  const { evaluate, input, report } = ctx
  const { frame, file } = await ctx.run.open(FENCE_INFO_DOC, 'ir')
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await placeCaret(frame, '[data-type="code-block-info"]', 'js', 2)
  await frames(frame)
  let state = await snapshot(frame)
  report.record('placed at the end of the info text', state)
  expect(state).toMatchObject({ inMarker: true, focused: true })
  // The info text node carries a leading zero-width space; the caret is at its end.
  expect(state.text).toContain('js')
  expect(state.offset).toBe(state.text?.length)
  const before = checkpoints(state).length
  await input.type('x')
  await frames(frame)
  await expect
    .poll(async () => (await snapshot(frame)).delivered)
    .toEqual(['x'])
  await expect
    .poll(async () => checkpoints(await snapshot(frame)).length, {
      timeout: 5_000,
      message: 'Task 609 checkpoint after typing in the info line',
    })
    .toBe(before + 1)
  await frames(frame, 20)
  state = await snapshot(frame)
  report.record('after the checkpoint', state)
  expect(state.inMarker).toBe(true)
  expect(state.text).toContain('jsx')
  expect(state.offset).toBe(state.text?.length)

  await input.type('y')
  await frames(frame)
  await expect
    .poll(async () => (await snapshot(frame)).delivered)
    .toEqual(['x', 'y'])
  await expect.poll(() => docText(evaluate, file)).toBe(FENCE_INFO_TYPED)
  report.record('typed y', {
    ...(await snapshot(frame)),
    host: await docText(evaluate, file),
  })
})

// Affected modes: the same two routes in WYSIWYG (no marker text nodes, so no tie): the heading
// route is asserted; the Turn Into outcome is recorded (see turnIntoFenceRoute).
xtestTest(
  'WYSIWYG: the heading checkpoint keeps the content start and the Turn Into outcome is recorded',
  async (ctx) => {
    await headingCheckpointRoute('wysiwyg', ctx)
    await turnIntoFenceRoute('wysiwyg', ctx)
  },
)

// Contract 4 (S2b open item): the Details toggle's own selection of the wrapped body is not pulled
// back by a live caret intent that its Undo checkpoint armed. The real toolbar route.
xtestTest(
  'IR Details toggle: the selection of the wrapped body is not reasserted',
  async (ctx) => {
    const { evaluate, report } = ctx
    const { frame, file } = await ctx.run.open(DETAILS_DOC, 'ir')
    await frame.locator('body').evaluate(() => {
      const inner = (window as any).vditor.vditor
      const root = inner.ir.element as HTMLElement
      const find = (selector: string, text: string) =>
        Array.from(root.querySelectorAll<HTMLElement>(selector)).find(
          (candidate) => candidate.textContent?.includes(text),
        )!
      const edge = (element: HTMLElement, last: boolean) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const nodes: Text[] = []
        for (let node = walker.nextNode(); node; node = walker.nextNode())
          if (!node.parentElement?.closest('[data-render]'))
            nodes.push(node as Text)
        return last ? nodes.at(-1)! : nodes[0]
      }
      const start = edge(find('p', 'Toolbar body'), false)
      const end = edge(find('li', 'toolbar item'), true)
      const range = document.createRange()
      range.setStart(start, 0)
      range.setEnd(end, end.length)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      root.focus({ preventScroll: true })
      document.dispatchEvent(new Event('selectionchange'))
    })
    await frames(frame)
    const selected = await snapshot(frame)
    report.record('body selected', selected)
    expect(selected.collapsed).toBe(false)
    expect(selected.selected).toContain('Toolbar body')
    expect(selected.selected).toContain('toolbar item')

    const toolbar = frame.locator('.vditor-toolbar [data-type="details"]')
    await expect(toolbar).toBeEnabled()
    await toolbar.click()
    await expect.poll(() => docText(evaluate, file)).toBe(DETAILS_WRAPPED)
    await frames(frame, 20)
    const after = await snapshot(frame)
    report.record('after the toggle and 20 frames', {
      ...after,
      host: await docText(evaluate, file),
    })
    expect(after.collapsed).toBe(false)
    expect(after.selected).toBe(selected.selected)
  },
)
