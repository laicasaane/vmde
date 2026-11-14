/**
 * Task 720 Part 2c (D2) — the history coupling's fast document read is byte-identical to Vditor's
 * full `getValue()`, in the real VS Code webview.
 *
 * The Undo/Redo wrapper (undo-keybind.ts) reads the document before and after every history step
 * and posts both texts to the host (`history-transition`). In IR, edit-sync's `historyText` now
 * serves those reads from the incremental IR serializer instead of a whole-document `getValue()`
 * (0.5 to 0.9 s per read on a 112 KB document). This spec turns on the E2E-only audit
 * (`__vmdeE2EHistoryAudit`): every `historyText` read also runs `getValue()` on the same DOM and
 * records whether the two agree. Each test types into one paragraph, pastes a multi-block snippet,
 * then sends Undo, Undo, Redo, Redo through VS Code's keybindings, and asserts:
 * - every read inside those history steps equals `getValue()` byte for byte;
 * - the reads on the large documents took the incremental path (so the identity covers it);
 * - a direct `historyText` read after typing and after the paste equals `getValue()`;
 * - the editor and the host document reach the expected text after each step.
 * Fixtures: a small document (below the incremental gate: the full path), a 112 KB document with
 * front matter, tables, code, Mermaid, callouts and lists, the same document with CRLF line
 * endings, and a table- and list-heavy document.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
} from './webview-helpers'

type Frame = Awaited<ReturnType<typeof reopenVmdeFixture>>
type HostEvaluator = Parameters<typeof reopenVmdeFixture>[0]

const MARK = 'HISTORYSITE'
const TYPED = 'qzx'
const PASTED = 'pasted alpha\n\npasted beta\n\n- pasted item'

interface Audit {
  path: 'incremental' | 'full'
  equal: boolean
  length: number
  fullLength: number
  firstDiff: number
  fast: string
  full: string
}

const filler = (seed: number, count: number) =>
  Array.from({ length: count }, (_, i) => `t${(seed * 17 + i * 5) % 991}`).join(
    ' ',
  )

function smallFixture(): string {
  return [
    '---\ntitle: History text\ntags: [undo]\n---',
    '# History text',
    `Opening ${filler(1, 12)}.`,
    `The ${MARK} paragraph takes the edit.`,
    '| A | B |\n| - | - |\n| 1 | 2 |',
    '```py\nprint("history")\n```',
    '- one\n  - nested\n- two',
    `Closing ${filler(2, 12)}.`,
  ].join('\n\n')
}

// About 112 KB of mixed content with the edit site in the middle.
function mixedLargeFixture(): string {
  const parts = [
    '---\ntitle: History text large\nkeywords: [undo, redo, history]\n---',
    '# History text large',
    '```mermaid\nflowchart LR\n  A[Key] --> B[Read]\n  B --> C[Post]\n```',
    '> [!NOTE]\n> The history read must match the full serializer.',
  ]
  for (let k = 1; parts.join('\n\n').length < 112_000; k++)
    parts.push(
      [
        `## Section ${k}`,
        `Section ${k} text with *emphasis* and [a link](https://example.com/${k}): ${filler(k, 28)}.`,
        `| Col | Val |\n| --- | --- |\n| s${k} | ${filler(k, 3)} |`,
        `\`\`\`ts\nconst section${k} = ${k}\n\`\`\``,
        `- [ ] task ${k}\n- [x] done ${k}\n  1. nested ${k}`,
        `> quote ${k}: ${filler(k + 300, 10)}`,
        ...(k === 25 ? [`The ${MARK} paragraph sits in the middle.`] : []),
      ].join('\n\n'),
    )
  return parts.join('\n\n')
}

// Over the 700-block incremental gate with mostly tables and lists.
function tableListFixture(): string {
  const parts = ['# Tables and lists']
  for (let k = 1; k <= 260; k++) {
    parts.push(
      `| K${k} | V${k} | W |\n| :-- | --: | :-: |\n| ${filler(k, 2)} | ${k} | x |`,
    )
    parts.push(`1. first ${k}\n2. second ${k}\n   - inner ${k}`)
    parts.push(`* star ${k}\n* star ${k}b`)
    if (k === 130) parts.push(`The ${MARK} paragraph between tables.`)
  }
  return parts.join('\n\n')
}

async function openIr(
  evaluate: HostEvaluator,
  workbox: Page,
  file: string,
): Promise<Frame> {
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
    { message: 'history text: editor ready', timeout: 60_000 },
  )
  if (opened.mode !== 'ir') {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator('button[data-mode="ir"]').click()
    await waitForE2EReadiness(
      frame,
      (s) => s.routerReady && s.editorEpoch > 0 && s.mode === 'ir',
      { message: 'history text: IR ready', timeout: 60_000 },
    )
  }
  await waitForInitialUndoSnapshot(frame)
  return frame
}

// Caret after the edit-site word; returns the word's centre relative to the IR root for the click.
function caretAtMark(_body: Element, mark: string) {
  const root = (window as any).vditor.vditor.ir.element as HTMLElement
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent?.indexOf(mark) ?? -1
    if (at < 0) continue
    node.parentElement?.scrollIntoView({ block: 'center' })
    const word = document.createRange()
    word.setStart(node, at)
    word.setEnd(node, at + mark.length)
    const rect = word.getBoundingClientRect()
    const base = root.getBoundingClientRect()
    const range = document.createRange()
    range.setStart(node, at + mark.length)
    range.collapse(true)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
    root.focus({ preventScroll: true })
    return {
      x: rect.left + rect.width / 2 - base.left,
      y: rect.top + rect.height / 2 - base.top,
    }
  }
  return null
}

const editorValue = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue() as string)

const stackLength = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        ((globalThis as any).__vmdeUnitHistory?.holds(
          (window as any).vditor.vditor,
        )
          ? (globalThis as any).__vmdeUnitHistory.depth(
              (window as any).vditor.vditor,
            ).undo
          : (window as any).vditor.vditor.undo.ir.undoStack.length) as number,
    )

// A direct read outside a history step: the fast read against getValue on the same DOM.
const directRead = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const w = window as any
    const fast = w.__vmdeE2EHistoryText() as string
    return { equal: fast === w.vditor.getValue(), length: fast.length }
  })

const takeAudit = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const w = window as any
    const audit = (w.__vmdeE2EHistoryAudit ?? []) as unknown[]
    w.__vmdeE2EHistoryAudit = []
    return audit
  }) as Promise<Audit[]>

async function historyKey(
  frame: Frame,
  workbox: Page,
  evaluate: HostEvaluator,
  file: string,
  key: 'Control+z' | 'Control+y',
  expected: { editor: string; host: string },
  label: string,
): Promise<Audit[]> {
  await workbox.keyboard.press(key)
  await expect
    .poll(() => editorValue(frame), { timeout: 30_000, message: label })
    .toBe(expected.editor)
  await expect
    .poll(() => docText(evaluate, file), {
      timeout: 30_000,
      message: `${label} host`,
    })
    .toBe(expected.host)
  return takeAudit(frame)
}

async function runScenario(
  evaluate: HostEvaluator,
  workbox: Page,
  baseDir: string,
  name: string,
  markdown: string,
  largeDocument: boolean,
) {
  const file = path.join(baseDir, `${name}.md`)
  writeFileSync(file, markdown)
  await evaluate(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.env.clipboard.writeText(args[0])
    },
    [PASTED] as [string],
  )
  const frame = await openIr(evaluate, workbox, file)
  await frame.locator('body').evaluate(() => {
    ;(window as any).__vmdeE2EHistoryAudit = []
  })
  const point = await frame.locator('body').evaluate(caretAtMark, MARK)
  expect(point, `${name}: edit site found`).not.toBeNull()
  await frame
    .locator('.vditor-ir .vditor-reset')
    .first()
    .click({ position: point as { x: number; y: number } })
  expect(await frame.locator('body').evaluate(caretAtMark, MARK)).not.toBeNull()
  const original = {
    editor: await editorValue(frame),
    host: await docText(evaluate, file),
  }

  let stack = await stackLength(frame)
  await workbox.keyboard.type(TYPED, { delay: 40 })
  await expect
    .poll(() => stackLength(frame), {
      timeout: 20_000,
      message: `${name}: typing recorded`,
    })
    .toBeGreaterThan(stack)
  await expect
    .poll(() => docText(evaluate, file), { timeout: 20_000 })
    .toContain(`${MARK}${TYPED}`)
  const typed = {
    editor: await editorValue(frame),
    host: await docText(evaluate, file),
  }
  expect(await directRead(frame), `${name}: direct read after typing`).toEqual({
    equal: true,
    length: typed.editor.length,
  })

  stack = await stackLength(frame)
  await workbox.keyboard.press('Control+v')
  await expect
    .poll(() => stackLength(frame), {
      timeout: 20_000,
      message: `${name}: paste recorded`,
    })
    .toBeGreaterThan(stack)
  await expect
    .poll(() => docText(evaluate, file), { timeout: 20_000 })
    .toContain('pasted beta')
  const pasted = {
    editor: await editorValue(frame),
    host: await docText(evaluate, file),
  }
  expect(pasted.editor).toContain('pasted item')
  expect(await directRead(frame), `${name}: direct read after paste`).toEqual({
    equal: true,
    length: pasted.editor.length,
  })
  // Reads before the history keys (checkpoints, direct reads) are not part of a transition.
  await takeAudit(frame)

  const steps: [string, Audit[]][] = []
  const step = async (
    key: 'Control+z' | 'Control+y',
    expected: { editor: string; host: string },
    label: string,
  ) =>
    steps.push([
      label,
      await historyKey(frame, workbox, evaluate, file, key, expected, label),
    ])
  await step('Control+z', typed, `${name}: Undo paste`)
  await step('Control+z', original, `${name}: Undo typing`)
  await step('Control+y', typed, `${name}: Redo typing`)
  await step('Control+y', pasted, `${name}: Redo paste`)

  console.log(
    `[history-text] ${name} ${JSON.stringify(
      steps.map(([label, audit]) => [
        label,
        audit.map((a) => `${a.path}:${a.equal ? 'eq' : `diff@${a.firstDiff}`}`),
      ]),
    )}`,
  )
  for (const [label, audit] of steps) {
    // Each step reads before and after the engine call; a step may also see a checkpoint read.
    expect(audit.length, `${label}: history reads`).toBeGreaterThanOrEqual(2)
    expect(
      audit.filter((a) => !a.equal),
      `${label}: every history read equals getValue()`,
    ).toEqual([])
    expect(
      audit.map((a) => a.path),
      `${label}: read path`,
    ).toEqual(audit.map(() => (largeDocument ? 'incremental' : 'full')))
  }
}

test.describe('History text equals getValue in IR (Task 720 Part 2c)', () => {
  test('small document (full path)', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    await runScenario(
      evaluateInVSCode as HostEvaluator,
      workbox as Page,
      baseDir,
      'history-text-small',
      smallFixture(),
      false,
    )
  })

  test('112 KB mixed document (incremental path)', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(360_000)
    const markdown = mixedLargeFixture()
    expect(markdown.length).toBeGreaterThan(110_000)
    await runScenario(
      evaluateInVSCode as HostEvaluator,
      workbox as Page,
      baseDir,
      'history-text-large',
      markdown,
      true,
    )
  })

  test('112 KB mixed document with CRLF line endings', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(360_000)
    await runScenario(
      evaluateInVSCode as HostEvaluator,
      workbox as Page,
      baseDir,
      'history-text-crlf',
      mixedLargeFixture().replace(/\n/g, '\r\n'),
      true,
    )
  })

  test('table- and list-heavy document', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(360_000)
    await runScenario(
      evaluateInVSCode as HostEvaluator,
      workbox as Page,
      baseDir,
      'history-text-tables-lists',
      tableListFixture(),
      true,
    )
  })
})
