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

const DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n'
const PARAGRAPH =
  'Alpha bravo charlie delta.\n\n# Probe\n\nEcho `foxtrot` golf hotel.\n'
// Measured by relay 2 on unchanged HEAD: the reference had Probe@0 outside the marker,
// XTEST delivered Ctrl+B and exactly one Q, and host/writeback agreed on these bytes.
const BOLD_HOTKEY =
  '# **Q**Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n'
// Relay 3 delivered one Q and confirmed these exact host/webview strings on unchanged HEAD.
const BOLD_TOOLBAR = BOLD_HOTKEY
const CODE =
  '# Q``Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n'
const PARAGRAPH_BOLD =
  '**Q**Alpha bravo charlie delta.\n\n# Probe\n\nEcho `foxtrot` golf hotel.\n'
const OUTPUT = path.resolve(
  __dirname,
  '../../tmp/task600-checks/s3b/observations',
)
const PIN_STATUS = {
  headingBoldHotkey: 'measured: relay 2',
  headingBoldToolbar: 'measured: relay 3',
  headingInlineCode: 'measured: relay 3',
  paragraphBold: 'measured: relay 3',
  wysiwyg: 'recorded: relays 4-5; no exact product assertion',
  sv: 'recorded: relay 5; no exact product assertion',
}

type Mode = 'ir' | 'wysiwyg' | 'sv'
type Frame = Awaited<ReturnType<typeof reopenVmdeFixture>>
type HostEvaluator = Parameters<typeof docText>[0]
interface Input {
  key(key: string): Promise<void>
  type(text: string): Promise<void>
}

interface SetupEvent {
  kind: 'undoCheckpoint' | 'caretRequest'
  t: number
  intent: unknown
  undoStackLength: number
}

const state = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const outer = window as unknown as {
      vditor: {
        getValue(): string
        vditor: {
          currentMode: string
          ir: { range?: Range; element: HTMLElement }
          wysiwyg: { element: HTMLElement }
          sv: { element: HTMLElement }
          undo: Record<string, { undoStack: unknown[] }>
          toolbar?: { elements?: { bold?: { children: HTMLCollection } } }
        }
      }
      __task600Input?: string[]
      __task600Trace?: SetupEvent[]
      __task600TraceOwner?: unknown
      __task600WrappedCaret?: unknown
      __task600WrappedUndo?: unknown
    }
    const inner = outer.vditor.vditor
    const root = inner[inner.currentMode as Mode].element
    const setupTrace = outer.__task600Trace?.slice() ?? []
    const selection = getSelection()
    const anchor = selection?.anchorNode
    const element = anchor instanceof Element ? anchor : anchor?.parentElement
    return {
      mode: inner.currentMode,
      isRoot: anchor === root,
      inEditor: !!anchor && root.isConnected && root.contains(anchor),
      focused: document.activeElement === root,
      anchorText: anchor instanceof Text ? anchor.data : null,
      anchorOffset: selection?.anchorOffset ?? -1,
      inHeading: !!element?.closest('h1,h2,h3,h4,h5,h6'),
      inMarker: !!element?.closest('.vditor-ir__marker'),
      blockText: element?.closest('[data-block]')?.textContent ?? null,
      rangeCount: selection?.rangeCount ?? 0,
      hasIrRange: !!inner.ir.range,
      value: outer.vditor.getValue(),
      delivered: outer.__task600Input ?? [],
      undoStackLength: inner.undo[inner.currentMode]?.undoStack.length ?? 0,
      setupTrace,
      undoCheckpointCalls: setupTrace.filter(
        (event) => event.kind === 'undoCheckpoint',
      ).length,
      traceLive:
        inner.undo === outer.__task600TraceOwner &&
        inner.undo.addToUndoStack === outer.__task600WrappedUndo &&
        (window as any).__vmdeRequestCaret === outer.__task600WrappedCaret,
      boldDisabled:
        inner.toolbar?.elements?.bold?.children[0]?.classList.contains(
          'vditor-menu--disabled',
        ) ?? false,
    }
  })

async function installSetupTrace(frame: Frame) {
  await frame.locator('body').evaluate(() => {
    const target = window as any
    const inner = target.vditor?.vditor
    if (!inner?.undo || typeof inner.undo.addToUndoStack !== 'function')
      throw new Error('Task 600 cannot trace the live Undo instance')
    if (typeof target.__vmdeRequestCaret !== 'function')
      throw new Error('Task 600 cannot trace the live caret bridge')
    const trace: SetupEvent[] = []
    target.__task600Trace = trace
    target.__task600TraceOwner = inner.undo
    const stackLength = () =>
      inner.undo[inner.currentMode]?.undoStack.length ?? 0
    const originalCheckpoint = inner.undo.addToUndoStack.bind(inner.undo)
    inner.undo.addToUndoStack = (...args: unknown[]) => {
      trace.push({
        kind: 'undoCheckpoint',
        t: performance.now(),
        intent: null,
        undoStackLength: stackLength(),
      })
      return originalCheckpoint(...args)
    }
    target.__task600WrappedUndo = inner.undo.addToUndoStack
    const originalCaret = target.__vmdeRequestCaret
    const wrappedCaret = (intent: unknown) => {
      // Node references are transient and non-JSON; retain intent coordinates without DOM text.
      const safeIntent =
        intent == null
          ? null
          : JSON.parse(
              JSON.stringify(intent, (_key, value) =>
                value instanceof Node ? { nodeName: value.nodeName } : value,
              ),
            )
      trace.push({
        kind: 'caretRequest',
        t: performance.now(),
        intent: safeIntent,
        undoStackLength: stackLength(),
      })
      return originalCaret(intent)
    }
    target.__task600WrappedCaret = wrappedCaret
    target.__vmdeRequestCaret = wrappedCaret
  })
}

async function waitForUndoCheckpoint(frame: Frame, mode: Mode) {
  await expect
    .poll(
      async () => {
        const snapshot = await state(frame)
        if (!snapshot.traceLive || snapshot.mode !== mode)
          throw new Error(`Task 600 setup trace detached from ${mode}`)
        return snapshot.undoStackLength
      },
      {
        timeout: 5_000,
        message: `Task 600 ${mode} opening Undo checkpoint did not finish`,
      },
    )
    .toBeGreaterThan(0)
}

function assertNoUndoRace(
  start: number,
  snapshot: { undoCheckpointCalls: number },
  leg: string,
) {
  expect(
    snapshot.undoCheckpointCalls,
    `undo checkpoint raced setup (${leg})`,
  ).toBe(start)
}

async function frames(frame: Frame) {
  await frame
    .locator('body')
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
}

interface Row {
  leg: string
  redOnHead: boolean
  failures: string[]
  host: string
}

function recorder(name: string) {
  const observations: Record<string, unknown>[] = []
  const rows: Row[] = []
  const persist = () => {
    mkdirSync(OUTPUT, { recursive: true })
    writeFileSync(
      path.join(OUTPUT, `${name}.json`),
      JSON.stringify({ pinStatus: PIN_STATUS, observations, rows }, null, 2),
    )
  }
  return {
    rows,
    async capture(
      leg: string,
      frame: Frame,
      evaluate: HostEvaluator,
      file: string,
      setup: Record<string, unknown> = {},
    ) {
      const snapshot = await state(frame)
      const host = await docText(evaluate, file)
      observations.push({ leg, ...snapshot, host, ...setup })
      persist()
      return { ...snapshot, host }
    },
    row(
      leg: string,
      redOnHead: boolean,
      host: string,
      checks: Record<string, boolean>,
    ) {
      rows.push({
        leg,
        redOnHead,
        host,
        failures: Object.entries(checks)
          .filter(([, pass]) => !pass)
          .map(([check]) => check),
      })
      persist()
    },
    async attach() {
      persist()
      await test.info().attach(name, {
        body: JSON.stringify({ observations, rows }, null, 2),
        contentType: 'application/json',
      })
    },
  }
}

function session(
  evaluate: HostEvaluator,
  workbox: Page,
  baseDir: string,
  input: Input,
) {
  let previous: string | undefined
  let serial = 0
  return {
    async fresh(doc = DOC, mode: Mode = 'ir') {
      // Save only this test's previous disposable document so closeAllEditors cannot open a
      // dirty-file confirmation dialog between legs. All measurements precede this cleanup.
      if (previous) {
        await evaluate(
          async (vscode: typeof import('vscode'), [file]: string[]) => {
            await vscode.workspace.textDocuments
              .find((item) => item.uri.fsPath === file)
              ?.save()
          },
          [previous],
        )
      }
      const file = path.join(baseDir, `task600-${++serial}.md`)
      writeFileSync(file, doc)
      previous = file
      // Mode is remembered across fresh documents. In particular the SV control follows a
      // WYSIWYG control; waiting for IR before switching would wait on a mode that never opens.
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
        { message: 'Task 600 live editor ready' },
      )
      await installSetupTrace(frame)
      // Vditor arms an opening Undo timer. Its patched checkpoint can replace a Probe@0 intent
      // with the heading-marker boundary at the same text offset; wait for that known setup work.
      await waitForUndoCheckpoint(frame, opened.mode as Mode)
      if (opened.mode !== mode) {
        await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
        await frame.locator(`button[data-mode="${mode}"]`).click()
      }
      await waitForE2EReadiness(
        frame,
        (s) => s.routerReady && s.editorEpoch > 0 && s.mode === mode,
        { message: `Task 600 ${mode} ready` },
      )
      if (opened.mode !== mode) await waitForUndoCheckpoint(frame, mode)
      expect(
        (await state(frame)).traceLive,
        'Task 600 setup trace survived mode switch',
      ).toBe(true)
      // Capture delivery independently of Markdown assertions so a dropped Q is reported as
      // an input failure before any formatting result is accepted.
      await frame.locator('body').evaluate(() => {
        const target = window as unknown as { __task600Input: string[] }
        target.__task600Input = []
        document.addEventListener(
          'beforeinput',
          (event) => {
            if (event.inputType === 'insertText' && event.data)
              target.__task600Input.push(event.data)
          },
          true,
        )
      })
      expect(await docText(evaluate, file)).toBe(doc)
      return { frame, file }
    },
    async key(frame: Frame, key: string) {
      await input.key(key)
      await frames(frame)
    },
    async home(frame: Frame, mode: Mode = 'ir') {
      const echo = frame
        .locator(`.vditor-${mode} p`)
        .filter({ hasText: 'Echo' })
        .first()
      if (mode === 'sv') {
        await frame.locator('.vditor-sv').click()
        await input.key('ctrl+End')
        await frames(frame)
      } else await echo.click()
      await frames(frame)
      const before = await state(frame)
      expect(before).toMatchObject({ focused: true, inEditor: true, mode })
      if (mode !== 'sv') expect(before.blockText).toContain('Echo')
      const checkpointStart = before.undoCheckpointCalls
      await input.key('ctrl+Home')
      await frames(frame)
      return {
        ...(await state(frame)),
        checkpointStart,
        undoStackLengthBefore: before.undoStackLength,
      }
    },
    async formatAndType(
      frame: Frame,
      file: string,
      format: 'bold' | 'inline-code',
      mouse = false,
      recordOnly = false,
    ) {
      const before = await state(frame)
      expect(before.focused, 'editor has focus before formatting').toBe(true)
      if (mouse)
        await frame.locator(`.vditor-toolbar [data-type="${format}"]`).click()
      else await input.key(format === 'bold' ? 'ctrl+b' : 'ctrl+g')
      await frames(frame)
      if (!recordOnly) {
        // Hotkeys make a host/webview round trip. Wait for the format command before sending Q;
        // two animation frames alone do not acknowledge delivery through the extension host.
        await expect
          .poll(async () => (await state(frame)).value)
          .not.toBe(before.value)
      }
      const afterFormat = await state(frame)
      expect(
        afterFormat.focused,
        'toolbar/hotkey preserves editable focus',
      ).toBe(true)
      await frame.locator('body').evaluate(() => {
        ;(window as unknown as { __task600Input: string[] }).__task600Input = []
      })
      await input.type('Q')
      await frames(frame)
      await expect
        .poll(async () => (await state(frame)).delivered, {
          message: 'exact Q beforeinput delivery; no retry/retype',
        })
        .toEqual(['Q'])
      if (recordOnly) {
        // Mode controls record the host and webview strings without a source-fidelity assertion.
        // The host write is deferred; this bounded sample observes it after the input tick.
        await frame
          .locator('body')
          .evaluate(() => new Promise((resolve) => setTimeout(resolve, 700)))
      } else {
        await expect.poll(async () => (await state(frame)).value).toContain('Q')
        // Tiny IR fixtures have canonical source. Host==webview acknowledges writeback there.
        await expect
          .poll(async () => await docText(evaluate, file))
          .toBe((await state(frame)).value)
      }
      return afterFormat
    },
  }
}

function assertRows(rows: Row[]) {
  // Keep the S3a HEAD classification for comparison, but require every row to pass in S3b.
  // Setup/delivery checks precede this aggregation; each leg also remains in the attached matrix.
  for (const row of rows.filter((item) => !item.redOnHead)) {
    expect(row.failures, `${row.leg}: guard`).toEqual([])
  }
  for (const row of rows.filter((item) => item.redOnHead)) {
    expect.soft(row.failures, `${row.leg}: post-fix contract`).toEqual([])
  }
}

test('T1 XTEST blockless caret legs (a)-(f) in one VS Code boot', async ({
  electronApp,
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'Requires isolated Xvfb + Openbox and VMDE_XTEST=1',
  )
  test.setTimeout(240_000)
  const evaluate = evaluateInVSCode as HostEvaluator
  const input = await createXtestInput(electronApp, workbox)
  const run = session(evaluate, workbox, baseDir, input)
  const report = recorder('real-vscode-T1')
  try {
    // Recheck the measured S3a content-start pins alongside the native Ctrl+Home legs.
    for (const reference of [
      { format: 'bold', mouse: false },
      { format: 'bold', mouse: true },
      { format: 'inline-code', mouse: false },
    ] as const) {
      const { format, mouse } = reference
      const label = `reference-${format}-${mouse ? 'toolbar' : 'hotkey'}`
      await test.step(`${label}: heading content-start`, async () => {
        const { frame, file } = await run.fresh()
        await frame.locator('.vditor-ir p').filter({ hasText: 'Echo' }).click()
        const placed = await frame
          .locator('#app .vditor-ir h1')
          .evaluate((heading) => {
            const { vditor, __vmdeRequestCaret: requestCaret } =
              window as unknown as {
                vditor: {
                  vditor: {
                    ir: { element: HTMLElement }
                    undo: { ir: { undoStack: unknown[] } }
                  }
                }
                __vmdeRequestCaret?: (intent: {
                  node: Node
                  offset: number
                }) => boolean
              }
            const root = vditor.vditor.ir.element
            if (!root.isConnected || !root.contains(heading))
              throw new Error('Reference heading is outside the live IR root')
            const text = Array.from(heading.childNodes).find(
              (node) => node instanceof Text && node.data === 'Probe',
            )
            if (!text) throw new Error('Heading content text not found')
            // A raw Selection collapse is not a gesture and cannot replace a live caret intent:
            // relay 1 restored Echo on the next frame. Use the existing authority for this
            // reference placement only; the measured Ctrl+Home legs remain entirely native.
            if (typeof requestCaret !== 'function')
              throw new Error('VMDE caret authority bridge is missing')
            root.focus({ preventScroll: true })
            const checkpointStart = (window as any).__task600Trace.filter(
              (event: SetupEvent) => event.kind === 'undoCheckpoint',
            ).length
            const undoStackLength = vditor.vditor.undo.ir.undoStack.length
            const delivered = requestCaret({ node: text, offset: 0 })
            document.dispatchEvent(new Event('selectionchange'))
            return { delivered, checkpointStart, undoStackLength }
          })
        expect(
          placed.delivered,
          'content-start reference placement delivered',
        ).toBe(true)
        expect(
          placed.undoStackLength,
          'opening Undo checkpoint finished before placement',
        ).toBeGreaterThanOrEqual(1)
        await frames(frame)
        const before = await report.capture(
          `${label}-before-format`,
          frame,
          evaluate,
          file,
          {
            checkpointAtPlacement: placed.checkpointStart,
            undoStackLengthAtPlacement: placed.undoStackLength,
          },
        )
        assertNoUndoRace(placed.checkpointStart, before, label)
        expect(before).toMatchObject({
          anchorText: 'Probe',
          anchorOffset: 0,
          inHeading: true,
          isRoot: false,
        })
        await run.formatAndType(frame, file, format, mouse)
        const result = await report.capture(label, frame, evaluate, file)
        if (format === 'bold' && !mouse) {
          expect(result.host).toBe(BOLD_HOTKEY)
        } else if (format === 'bold') {
          expect(result.host).toBe(BOLD_TOOLBAR)
        } else {
          expect(result.host).toBe(CODE)
        }
      })
    }

    for (const leg of [
      {
        id: 'a',
        format: 'bold',
        mouse: false,
        doc: DOC,
        expected: BOLD_HOTKEY,
        redOnHead: true,
      },
      {
        id: 'b',
        format: 'bold',
        mouse: true,
        doc: DOC,
        expected: BOLD_TOOLBAR,
        redOnHead: true,
      },
      {
        id: 'c',
        format: 'inline-code',
        mouse: false,
        doc: DOC,
        expected: CODE,
        redOnHead: true,
      },
      {
        id: 'd',
        format: 'bold',
        mouse: false,
        doc: PARAGRAPH,
        expected: PARAGRAPH_BOLD,
        redOnHead: false,
      },
    ] as const) {
      await test.step(`(${leg.id}) Ctrl+Home then ${leg.mouse ? 'toolbar' : 'hotkey'} ${leg.format}`, async () => {
        const { frame, file } = await run.fresh(leg.doc)
        const afterHome = await run.home(frame)
        const beforeFormat = await report.capture(
          `${leg.id}-after-home`,
          frame,
          evaluate,
          file,
          {
            checkpointAtHome: afterHome.checkpointStart,
            undoStackLengthAtHome: afterHome.undoStackLengthBefore,
          },
        )
        assertNoUndoRace(afterHome.checkpointStart, beforeFormat, leg.id)
        await run.formatAndType(frame, file, leg.format, leg.mouse)
        const result = await report.capture(leg.id, frame, evaluate, file)
        report.row(leg.id, leg.redOnHead, result.host, {
          'Ctrl+Home stays inside a block':
            afterHome.inEditor && !afterHome.isRoot,
          'exact host Markdown (see pinStatus)': result.host === leg.expected,
          'no new top-level format paragraph':
            !result.host.startsWith('**Q**\n\n') &&
            !result.host.startsWith('`Q`\n\n'),
          ...(leg.id === 'd'
            ? {
                'paragraph control retains Alpha and Q':
                  result.host.split('\n\n')[0].includes('Alpha') &&
                  result.host.split('\n\n')[0].includes('Q'),
                'paragraph control retains heading':
                  result.host.includes('\n\n# Probe\n\n'),
              }
            : { 'heading remains first': result.host.startsWith('# ') }),
        })
      })
    }

    await test.step('(e) Find Return Escape then Bold', async () => {
      const { frame, file } = await run.fresh()
      const afterHome = await run.home(frame)
      await run.key(frame, 'ctrl+f')
      const widget = frame.locator('.vmde-find-replace')
      const find = widget.locator('[data-find]')
      await expect(find).toBeFocused()
      await input.type('bravo')
      await expect(
        find,
        'exact Find input before Return; no retry/retype',
      ).toHaveValue('bravo')
      await expect(widget.locator('[data-status]')).toHaveText('1 of 1')
      await run.key(frame, 'Return')
      await run.key(frame, 'Escape')
      await expect(widget).toBeHidden()
      const afterFind = await report.capture(
        'e-after-find',
        frame,
        evaluate,
        file,
        {
          checkpointAtHome: afterHome.checkpointStart,
          undoStackLengthAtHome: afterHome.undoStackLengthBefore,
        },
      )
      assertNoUndoRace(afterHome.checkpointStart, afterFind, 'e')
      await run.formatAndType(frame, file, 'bold')
      const result = await report.capture('e', frame, evaluate, file)
      report.row('e', true, result.host, {
        'Find close stays inside a block':
          afterFind.inEditor && !afterFind.isRoot,
        'host does not begin with bold syntax': !/^\*\*/.test(result.host),
        'heading remains first': result.host.split('\n')[0].startsWith('# '),
      })
    })

    for (const mode of ['wysiwyg', 'sv'] as const) {
      await test.step(`(f) ${mode} Ctrl+Home then Bold`, async () => {
        const { frame, file } = await run.fresh(DOC, mode)
        await run.home(frame, mode)
        await report.capture(`f-${mode}-after-home`, frame, evaluate, file)
        await run.formatAndType(frame, file, 'bold', false, true)
        const result = await report.capture(`f-${mode}`, frame, evaluate, file)
        await test.info().attach(`f-${mode}-host.md`, {
          body: result.host,
          contentType: 'text/markdown',
        })
        if (mode === 'wysiwyg') {
          expect(
            result.host.startsWith('# '),
            'DESIGN QUESTION: WYSIWYG must not create a new top-level block',
          ).toBe(true)
        } else {
          expect(
            result.host,
            'DESIGN QUESTION: SV must not insert a new block before the heading',
          ).not.toMatch(/\n\n# Probe(?:\n|$)/)
        }
        // Mode legs are observations. Keep their exact strings and caret/Undo trace in the JSON.
        report.row(`f-${mode}`, false, result.host, {})
      })
    }
  } finally {
    await report.attach()
  }
  assertRows(report.rows)
})

test('T2 CDP nightly Ctrl+Home and fresh toolbar Bold', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)
  const evaluate = evaluateInVSCode as HostEvaluator
  const run = session(evaluate, workbox, baseDir, {
    key: (key) =>
      workbox.keyboard.press(
        key.replace('ctrl+', 'Control+').replace('Return', 'Enter'),
      ),
    type: (text) => workbox.keyboard.type(text),
  })
  const report = recorder('real-vscode-T2')
  try {
    const { frame, file } = await run.fresh()
    const afterHome = await run.home(frame)
    await report.capture('a-after-home', frame, evaluate, file)
    await run.formatAndType(frame, file, 'bold')
    const result = await report.capture('a', frame, evaluate, file)
    report.row('a', true, result.host, {
      'Ctrl+Home stays inside a block': afterHome.inEditor && !afterHome.isRoot,
      'exact host Markdown (measured hotkey pin)': result.host === BOLD_HOTKEY,
      'no leading bold block': !/^\*\*/.test(result.host),
    })

    const fresh = await run.fresh()
    const before = await report.capture(
      'fresh-before-bold',
      fresh.frame,
      evaluate,
      fresh.file,
    )
    await fresh.frame.locator('.vditor-toolbar [data-type="bold"]').click()
    await frames(fresh.frame)
    // Negative assertion window: cover the asynchronous toolbar writeback, including a no-op.
    await fresh.frame
      .locator('body')
      .evaluate(() => new Promise((resolve) => setTimeout(resolve, 700)))
    const after = await report.capture(
      'fresh-after-bold',
      fresh.frame,
      evaluate,
      fresh.file,
    )
    report.row('fresh-toolbar', true, after.host, {
      'host unchanged': after.host === DOC,
      'webview unchanged': after.value === before.value && after.value === DOC,
    })
  } finally {
    await report.attach()
  }
  assertRows(report.rows)
})
