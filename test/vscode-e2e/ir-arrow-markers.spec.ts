import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
} from './webview-helpers'

// Task 648 — ArrowLeft/ArrowRight move one source character per press through the revealed
// Markdown markers of an inline node in IR, in the real VS Code webview with OS-level keys (XTEST).
// Run under the isolated Xvfb + Openbox shell with VMDE_XTEST=1 (DEVELOPMENT.md). Keys are never
// DOM-synthesized. The caret is placed once programmatically (a deterministic setup position,
// as the other caret specs do); every movement after that is an OS key.
//
// Source offset: characters of the block before the caret, counting marker text and content,
// excluding text inside `[data-render]` / `.vditor-ir__preview` and U+200B.

type Frame = Awaited<ReturnType<typeof reopenVmdeFixture>>
type HostEvaluator = Parameters<typeof docText>[0]

const OUTPUT = path.resolve(__dirname, '../../tmp/task648-checks/s3')

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

async function installOffsets(frame: Frame) {
  await frame.locator('body').evaluate(() => {
    const w = window as any
    w.__t648Offset = (node: Node, offset: number): number => {
      const el = node instanceof Element ? node : node.parentElement
      const block = el?.closest('.vditor-reset > p')
      if (!block) return -9
      const prefix = document.createRange()
      prefix.setStart(block, 0)
      prefix.setEnd(node, offset)
      let length = 0
      const walker = document.createTreeWalker(
        prefix.cloneContents(),
        NodeFilter.SHOW_TEXT,
      )
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        if (
          (t.parentElement as Element | null)?.closest(
            '[data-render], .vditor-ir__preview',
          )
        )
          continue
        length += (t as Text).data.replace(/​/g, '').length
      }
      return length
    }
    w.__t648Place = (index: number) => {
      const inner = w.vditor.vditor
      const root = inner.ir.element as HTMLElement
      root.focus({ preventScroll: true })
      const range = document.createRange()
      range.setStart(root.children[index], 0)
      range.collapse(true)
      const s = getSelection()!
      s.removeAllRanges()
      s.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    }
  })
}

const caret = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const w = window as any
    const s = getSelection()!
    return {
      anchor: w.__t648Offset(s.anchorNode, s.anchorOffset) as number,
      focus: w.__t648Offset(s.focusNode, s.focusOffset) as number,
      value: w.vditor.getValue() as string,
      undoStack: (((globalThis as any).__vmdeUnitHistory?.holds(w.vditor.vditor)
        ? (globalThis as any).__vmdeUnitHistory.depth(w.vditor.vditor).undo
        : w.vditor.vditor.undo.ir?.undoStack?.length) ?? 0) as number,
    }
  })

function xtestTest(
  title: string,
  body: (ctx: {
    evaluate: HostEvaluator
    frame: Frame
    file: string
    input: Awaited<ReturnType<typeof createXtestInput>>
    log: (name: string, data: unknown) => void
  }) => Promise<void>,
  doc: string,
) {
  test(title, async ({ electronApp, workbox, evaluateInVSCode, baseDir }) => {
    test.skip(
      process.env.VMDE_XTEST !== '1',
      'Requires isolated Xvfb + Openbox and VMDE_XTEST=1',
    )
    test.setTimeout(240_000)
    const evaluate = evaluateInVSCode as HostEvaluator
    const file = path.join(
      baseDir,
      `task648-${title
        .replace(/[^a-z0-9]+/gi, '-')
        .toLowerCase()
        .slice(0, 40)}.md`,
    )
    writeFileSync(file, doc)
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
      { message: 'Task 648 editor ready' },
    )
    if (opened.mode !== 'ir') {
      await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
      await frame.locator('button[data-mode="ir"]').click()
      await waitForE2EReadiness(
        frame,
        (s) => s.routerReady && s.editorEpoch > 0 && s.mode === 'ir',
        { message: 'Task 648 ir ready' },
      )
    }
    await waitForInitialUndoSnapshot(frame)
    await installOffsets(frame)
    const observations: Record<string, unknown> = {}
    try {
      await body({
        evaluate,
        frame,
        file,
        input: await createXtestInput(electronApp, workbox as Page),
        log: (name, data) => {
          observations[name] = data
        },
      })
    } finally {
      mkdirSync(OUTPUT, { recursive: true })
      const name = title
        .replace(/[^a-z0-9]+/gi, '-')
        .toLowerCase()
        .slice(0, 50)
      writeFileSync(
        path.join(OUTPUT, `${name}.json`),
        JSON.stringify(observations, null, 2),
      )
    }
  })
}

// Focus the editor with a pointer click on the tail paragraph (a click only focuses), then put the
// caret at the start of block 0 and let the marker controller settle.
async function focusAtBlockStart(frame: Frame) {
  await frame.locator('.vditor-ir p').filter({ hasText: 'Tail' }).click()
  await frame.locator('body').evaluate(() => (window as any).__t648Place(0))
  await frames(frame)
}

async function walk(
  frame: Frame,
  input: Awaited<ReturnType<typeof createXtestInput>>,
  key: string,
  count: number,
) {
  const seen: number[] = []
  for (let i = 0; i < count; i++) {
    await input.key(key)
    await frames(frame)
    seen.push((await caret(frame)).focus)
  }
  return seen
}

const range = (from: number, to: number) =>
  from <= to
    ? Array.from({ length: to - from + 1 }, (_, i) => from + i)
    : Array.from({ length: from - to + 1 }, (_, i) => from - i)

// Acceptance 1: the Owner's example. Eleven OS ArrowRight presses visit 1..11, eleven ArrowLeft
// presses return through 10..0, and walking changes no host text.
const CONFIRM = '**Confirm**\n\nTail.\n'
xtestTest(
  '**Confirm**: OS ArrowRight visits offsets 1 to 11, ArrowLeft returns to 0',
  async ({ evaluate, frame, file, input, log }) => {
    await focusAtBlockStart(frame)
    expect((await caret(frame)).focus).toBe(0)
    const right = await walk(frame, input, 'Right', 11)
    const left = await walk(frame, input, 'Left', 11)
    log('walk', { right, left, host: await docText(evaluate, file) })
    expect(right).toEqual(range(1, 11))
    expect(left).toEqual(range(10, 0))
    expect(await docText(evaluate, file)).toBe(CONFIRM)
  },
  CONFIRM,
)

// Acceptance 2 (real VS Code part): a link and an inline code node in one paragraph.
const MIXED_SOURCE = 'a [t](u) b `c` d'
xtestTest(
  'link and inline code: OS ArrowRight/ArrowLeft step one source character per press',
  async ({ evaluate, frame, file, input, log }) => {
    await focusAtBlockStart(frame)
    const n = MIXED_SOURCE.length
    const right = await walk(frame, input, 'Right', n)
    const left = await walk(frame, input, 'Left', n)
    log('walk', { right, left, host: await docText(evaluate, file) })
    expect(right).toEqual(range(1, n))
    expect(left).toEqual(range(n - 1, 0))
    expect(await docText(evaluate, file)).toBe(`${MIXED_SOURCE}\n\nTail.\n`)
  },
  `${MIXED_SOURCE}\n\nTail.\n`,
)

// Acceptance 4: typing at offset 1 (between the two `*` of the opening marker) writes there in
// the host text, and one Ctrl+Z restores the host text.
xtestTest(
  '**Confirm**: typing at offset 1 writes there in the host text, one Undo restores it',
  async ({ evaluate, frame, file, input, log }) => {
    await focusAtBlockStart(frame)
    expect(await walk(frame, input, 'Right', 1)).toEqual([1])
    const before = await caret(frame)
    await input.type('x')
    await frames(frame)
    await expect
      .poll(() => docText(evaluate, file), {
        message: 'host text after typing',
      })
      .not.toBe(CONFIRM)
    const typed = await docText(evaluate, file)
    log('typed', { typed, caret: await caret(frame) })
    expect(typed).toBe('*x*Confirm**\n\nTail.\n')
    // The typed edit becomes its own Undo snapshot after Vditor's undo delay.
    await expect
      .poll(async () => (await caret(frame)).undoStack, {
        timeout: 5_000,
        message: 'Undo snapshot after typing',
      })
      .toBeGreaterThan(before.undoStack)
    await input.key('ctrl+z')
    await expect
      .poll(() => docText(evaluate, file), { message: 'host text after Undo' })
      .toBe(CONFIRM)
    log('undone', { host: await docText(evaluate, file) })
  },
  CONFIRM,
)
