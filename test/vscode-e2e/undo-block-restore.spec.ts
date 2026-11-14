/**
 * Task 720 — Undo and Redo restore only the blocks the step changed, in the real VS Code webview.
 *
 * Vditor's `Undo.renderDiff` used to rebuild the whole editor root (`element.innerHTML = text`) on
 * every Undo and Redo; the patched restore (esbuild-shared.mjs patchUndoBlockScopedRestore, helper
 * media-src/src/editing/undo-block-restore.ts) replaces only the changed top-level blocks. Each test
 * types a word into one paragraph, then sends Ctrl+Z and Ctrl+Y through VS Code's keybindings and
 * asserts, per step:
 * - the editor text is exactly the text before the step (Undo) or after the edit (Redo), and the
 *   host document follows;
 * - every top-level block except the edited paragraph (and the block the restored caret lands in,
 *   when the snapshot recorded the caret elsewhere) is the same DOM node as before the key. The
 *   blocks are marked with a JS property, which no HTML snapshot can copy;
 * - on the 112 KB document, the restore's share of the time from the key to the first DOM change
 *   stays under a bound, and so does the whole Undo/Redo task (key to the end of the history call,
 *   which includes the history coupling's reads before and after the step). Part 2c (D2) serves
 *   those reads from the incremental IR serializer; before it, each was a whole-document getValue
 *   of 0.5 to 1.1 s and the task took 1.2 to 1.4 s.
 * Split View has one top-level source node, so only the text is asserted there.
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

type Mode = 'ir' | 'wysiwyg' | 'sv'
type Frame = Awaited<ReturnType<typeof reopenVmdeFixture>>
type HostEvaluator = Parameters<typeof reopenVmdeFixture>[0]

const TYPED = 'qzx'
const EDIT_SITE = 'EDITSITE'
// The restore's share of the key-to-change time on the 112 KB document: the time from the key to the
// first DOM change minus the history coupling's two whole-document reads (readText = getValue, about
// 0.5 to 1.1 s each here, outside this fix). Measured with the probe (ir-undo-flicker-probe.spec.ts):
// before the fix 306 to 538 ms over 15 records (median 411: host round trip, whole-root rebuild,
// preview passes and every decorator's full pass), after it 186 to 402 ms over 27 records (median
// 258; the first record after opening is the slowest). The bound is a coarse guard against a return
// of the full rebuild's cost; the identity assertions are the regression check for the fix itself.
const LARGE_RESTORE_SHARE_MS = 450
// Task 720 Part 2c: the whole Undo/Redo task on the 112 KB document, from the key in the webview to
// the end of the coupled history call (prepare, both history reads, the engine restore and the
// transition post). Measured in this spec: 872 ms (Undo) and 1202 ms (Redo) with whole-document
// reads, 196 ms and 116 ms with the incremental reads; the bound leaves about 2.5 times that.
const LARGE_TASK_MS = 500

const words = (seed: number, count: number) =>
  Array.from({ length: count }, (_, i) => `w${(seed * 31 + i * 7) % 997}`).join(
    ' ',
  )

// About 3 KB: front matter, headings, prose, a list, a table, a code block, a Mermaid diagram and
// a callout, with the edit site between them.
function smallDocument(): string {
  const prose = (seed: number) => `Prose ${seed}: ${words(seed, 18)}.`
  return [
    '---\ntitle: Block restore\nkeywords: [undo, redo]\n---',
    '# Block restore',
    prose(1),
    prose(2),
    '- alpha item\n- beta item with `code`\n- gamma item',
    `The ${EDIT_SITE} paragraph receives the typed word.`,
    '| Key | Value |\n| --- | ----- |\n| one | first |\n| two | second |',
    '```js\nconst restore = (blocks) => blocks.length\n```',
    '```mermaid\nflowchart LR\n  K[Key] --> R[Restore]\n  R --> D[Done]\n```',
    '> [!TIP]\n> Only the changed block is rebuilt.',
    '## After',
    prose(3),
    prose(4),
    prose(5),
  ].join('\n\n')
}

// Over the 100,000-character content-visibility band: the small document, then sections of prose,
// a table, a code block and a list, with the edit site in the middle section.
function largeDocument(): string {
  const parts = [smallDocument().replace(EDIT_SITE, 'opening')]
  for (let k = 1; parts.join('\n\n').length < 112_000; k++)
    parts.push(
      [
        `## Part ${k}`,
        `Part ${k} opens: ${words(k, 30)}.`,
        `Part ${k} continues with **strong** and \`code ${k}\`: ${words(k + 400, 30)}.`,
        `| Part | Note |\n| ---- | ---- |\n| p${k} | ${words(k, 4)} |`,
        `\`\`\`ts\nexport const part${k} = ${k} + 1\n\`\`\``,
        `1. part ${k} first\n2. part ${k} second`,
        ...(k === 30
          ? [`The ${EDIT_SITE} paragraph sits deep in the document.`]
          : []),
      ].join('\n\n'),
    )
  return parts.join('\n\n')
}

const editorRoot = (mode: Mode) =>
  mode === 'sv' ? '.vditor-sv' : `.vditor-${mode} .vditor-reset`

async function openInMode(
  evaluate: HostEvaluator,
  workbox: Page,
  file: string,
  mode: Mode,
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
    { message: 'block restore: editor ready', timeout: 60_000 },
  )
  if (opened.mode !== mode) {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator(`button[data-mode="${mode}"]`).click()
    await waitForE2EReadiness(
      frame,
      (s) => s.routerReady && s.editorEpoch > 0 && s.mode === mode,
      { message: `block restore: ${mode} ready`, timeout: 60_000 },
    )
  }
  await waitForInitialUndoSnapshot(frame)
  if (mode !== 'sv')
    await frame
      .locator(`.vditor-${mode} .language-mermaid svg`)
      .first()
      .waitFor({ timeout: 60_000 })
  return frame
}

// Put the caret after the edit-site word (the text node is found inside the mode root) and return
// the centre of the word relative to the root, for the focus click.
function placeCaret(_body: Element, mode: Mode) {
  const root = (window as any).vditor.vditor[mode].element as HTMLElement
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent?.indexOf('EDITSITE') ?? -1
    if (at < 0) continue
    node.parentElement?.scrollIntoView({ block: 'center' })
    const word = document.createRange()
    word.setStart(node, at)
    word.setEnd(node, at + 'EDITSITE'.length)
    const rect = word.getBoundingClientRect()
    const base = root.getBoundingClientRect()
    const range = document.createRange()
    range.setStart(node, at + 'EDITSITE'.length)
    range.collapse(true)
    const selection = getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    root.focus({ preventScroll: true })
    return {
      x: rect.left + rect.width / 2 - base.left,
      y: rect.top + rect.height / 2 - base.top,
    }
  }
  return null
}

// Marks every top-level block with a JS property and times the next history key: from its keydown
// in the webview to the first MutationObserver callback on the root.
function arm(_body: Element, mode: Mode) {
  const w = window as any
  const root = w.vditor.vditor[mode].element as HTMLElement
  const children = Array.from(root.children)
  children.forEach((child, index) => {
    ;(child as any).__vmdeBlockRestoreMark = index
  })
  const state: any = {
    keyAt: null,
    changeAt: null,
    marked: children,
    reads: [] as number[][],
  }
  // The history coupling reads the whole document before and after the step (readText, the outer
  // getValue); their duration is recorded so the restore's own share can be told apart.
  const outer = w.vditor
  const ownGetValue = Object.hasOwn(outer, 'getValue')
  const getValue = outer.getValue
  outer.getValue = function (...args: unknown[]) {
    const start = performance.now()
    try {
      return getValue.apply(this, args)
    } finally {
      state.reads.push([start, performance.now()])
    }
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.ctrlKey && /^[zy]$/i.test(event.key) && state.keyAt === null)
      state.keyAt = performance.now()
  }
  window.addEventListener('keydown', onKey, true)
  const observer = new MutationObserver(() => {
    state.changeAt ??= performance.now()
  })
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  })
  state.stop = () => {
    observer.disconnect()
    window.removeEventListener('keydown', onKey, true)
    if (ownGetValue) outer.getValue = getValue
    else delete outer.getValue
  }
  // The coupled history call (undo-keybind.ts wraps `undo.undo` / `undo.redo`); its end bounds the
  // whole Undo/Redo task.
  const history = w.vditor.vditor.undo
  const coupled = { undo: history.undo, redo: history.redo }
  state.calls = [] as number[][]
  for (const kind of ['undo', 'redo'] as const)
    history[kind] = function (...args: unknown[]) {
      const start = performance.now()
      try {
        return coupled[kind].apply(this, args)
      } finally {
        state.calls.push([start, performance.now()])
      }
    }
  const stopTiming = state.stop
  state.stop = () => {
    stopTiming()
    history.undo = coupled.undo
    history.redo = coupled.redo
  }
  w.__vmdeBlockRestore = state
  return children.length
}

function inspect(_body: Element, mode: Mode) {
  const w = window as any
  const state = w.__vmdeBlockRestore
  state.stop()
  const root = w.vditor.vditor[mode].element as HTMLElement
  const marked = state.marked as Element[]
  const children = Array.from(root.children)
  const lost = marked
    .map((el, index) => (el.parentNode === root ? -1 : index))
    .filter((index) => index >= 0)
  const timed = state.keyAt !== null && state.changeAt !== null
  const readMs = (state.reads as number[][])
    .filter(([s, e]) => timed && s >= state.keyAt && e <= state.changeAt)
    .reduce((sum, [s, e]) => sum + (e - s), 0)
  return {
    blocks: children.length,
    lostCount: lost.length,
    lostFirst: lost.slice(0, 6),
    fresh: children.filter(
      (el) => (el as any).__vmdeBlockRestoreMark === undefined,
    ).length,
    editIndex: children.findIndex((el) => el.textContent?.includes('EDITSITE')),
    // The block the restored caret landed in (the snapshot's caret marker block).
    caretIndex: (() => {
      const anchor = getSelection()?.anchorNode
      return anchor
        ? children.findIndex((el) => el === anchor || el.contains(anchor))
        : -1
    })(),
    keyToChangeMs: timed ? Math.round(state.changeAt - state.keyAt) : null,
    readTextMs: Math.round(readMs),
    // Key to the end of the last coupled history call that started after the key.
    keyToTaskEndMs: (() => {
      const ends = (state.calls as number[][])
        .filter(([s]) => state.keyAt !== null && s >= state.keyAt)
        .map(([, e]) => e)
      return ends.length ? Math.round(Math.max(...ends) - state.keyAt) : null
    })(),
  }
}

const editorValue = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () => (window as any).vditor.getValue() as string,
    ) as Promise<string>

interface StepResult {
  blocks: number
  lostCount: number
  lostFirst: number[]
  fresh: number
  editIndex: number
  caretIndex: number
  keyToChangeMs: number | null
  readTextMs: number
  keyToTaskEndMs: number | null
}

async function historyStep(
  frame: Frame,
  workbox: Page,
  mode: Mode,
  key: 'Control+z' | 'Control+y',
  expected: string,
): Promise<StepResult> {
  await frame.locator('body').evaluate(arm, mode)
  await workbox.keyboard.press(key)
  // A cheap condition first: a getValue poll on the 112 KB document would occupy the webview while
  // the history key is still on its way through VS Code.
  await expect
    .poll(
      () =>
        frame
          .locator('body')
          .evaluate(() => (window as any).__vmdeBlockRestore.changeAt !== null),
      { timeout: 20_000, message: `${mode} ${key} DOM change` },
    )
    .toBe(true)
  await expect
    .poll(() => editorValue(frame), {
      timeout: 20_000,
      message: `${mode} ${key} text`,
    })
    .toBe(expected)
  return (await frame.locator('body').evaluate(inspect, mode)) as StepResult
}

async function typeThenUndoRedo(
  evaluate: HostEvaluator,
  workbox: Page,
  baseDir: string,
  mode: Mode,
  markdown: string,
  name: string,
) {
  const file = path.join(baseDir, `${name}.md`)
  writeFileSync(file, markdown)
  const frame = await openInMode(evaluate, workbox, file, mode)
  // Page-level keyboard focus for the nested webview (undo-redo-steps.spec.ts), then the caret. The
  // click lands on the edit site: a click elsewhere (the front matter) would be the caret of the
  // snapshot before the edit, and that block would be swapped too to restore the caret there.
  const point = await frame.locator('body').evaluate(placeCaret, mode)
  expect(point, 'edit site found').not.toBeNull()
  await frame
    .locator(editorRoot(mode))
    .first()
    .click({ position: point as { x: number; y: number } })
  expect(await frame.locator('body').evaluate(placeCaret, mode)).not.toBeNull()
  const before = await editorValue(frame)
  const hostBefore = await docText(evaluate, file)
  const stackBefore = await frame
    .locator('body')
    .evaluate(
      (_b, m) =>
        ((globalThis as any).__vmdeUnitHistory?.holds(
          (window as any).vditor.vditor,
        )
          ? (globalThis as any).__vmdeUnitHistory.depth(
              (window as any).vditor.vditor,
            ).undo
          : (window as any).vditor.vditor.undo[m as string].undoStack
              .length) as number,
      mode,
    )
  await workbox.keyboard.type(TYPED, { delay: 40 })
  // The edit is a history entry and reached the host before the history keys.
  await expect
    .poll(
      () =>
        frame
          .locator('body')
          .evaluate(
            (_b, m) =>
              ((globalThis as any).__vmdeUnitHistory?.holds(
                (window as any).vditor.vditor,
              )
                ? (globalThis as any).__vmdeUnitHistory.depth(
                    (window as any).vditor.vditor,
                  ).undo
                : (window as any).vditor.vditor.undo[m as string].undoStack
                    .length) as number,
            mode,
          ),
      { timeout: 20_000, message: `${mode} edit recorded` },
    )
    .toBeGreaterThan(stackBefore)
  await expect
    .poll(() => docText(evaluate, file), { timeout: 20_000 })
    .toContain(TYPED)
  const edited = await editorValue(frame)
  expect(edited).toContain(`${EDIT_SITE}${TYPED}`)
  const hostEdited = await docText(evaluate, file)

  const undo = await historyStep(frame, workbox, mode, 'Control+z', before)
  await expect
    .poll(() => docText(evaluate, file), { timeout: 20_000 })
    .toBe(hostBefore)
  const redo = await historyStep(frame, workbox, mode, 'Control+y', edited)
  await expect
    .poll(() => docText(evaluate, file), { timeout: 20_000 })
    .toBe(hostEdited)
  return { undo, redo }
}

// Every top-level block is the same node except the edited paragraph and, when the restored
// snapshot recorded its caret in another block, that block: Vditor restores the caret through the
// snapshot's marker, so the marker block is swapped on its own (measured in WYSIWYG: the opening
// snapshot recorded the caret in the front matter, and Undo returns the caret there).
function expectOnlyEditReplaced(step: StepResult, label: string) {
  expect(step.editIndex, `${label}: edit site found`).toBeGreaterThanOrEqual(0)
  const replaced = [...new Set([step.editIndex, step.caretIndex])]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)
  expect(
    {
      lostCount: step.lostCount,
      lostFirst: step.lostFirst,
      fresh: step.fresh,
    },
    `${label}: only blocks ${replaced.join(', ')} of ${step.blocks} are replaced`,
  ).toEqual({
    lostCount: replaced.length,
    lostFirst: replaced,
    fresh: replaced.length,
  })
}

test.describe('Undo/Redo restore only the changed blocks (Task 720)', () => {
  test('IR small document: Undo and Redo keep every unchanged block', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const { undo, redo } = await typeThenUndoRedo(
      evaluateInVSCode as HostEvaluator,
      workbox as Page,
      baseDir,
      'ir',
      smallDocument(),
      'block-restore-ir-small',
    )
    console.log(`[block-restore] ir small ${JSON.stringify({ undo, redo })}`)
    expectOnlyEditReplaced(undo, 'IR small Undo')
    expectOnlyEditReplaced(redo, 'IR small Redo')
  })

  test('IR 112 KB document: Undo and Redo keep every unchanged block within the time bound', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const markdown = largeDocument()
    expect(markdown.length).toBeGreaterThan(110_000)
    const { undo, redo } = await typeThenUndoRedo(
      evaluateInVSCode as HostEvaluator,
      workbox as Page,
      baseDir,
      'ir',
      markdown,
      'block-restore-ir-large',
    )
    console.log(`[block-restore] ir large ${JSON.stringify({ undo, redo })}`)
    expectOnlyEditReplaced(undo, 'IR large Undo')
    expectOnlyEditReplaced(redo, 'IR large Redo')
    for (const [label, step] of [
      ['Undo', undo],
      ['Redo', redo],
    ] as const) {
      expect(
        step.keyToChangeMs,
        `IR large ${label}: key seen and DOM changed`,
      ).not.toBeNull()
      expect(
        (step.keyToChangeMs as number) - step.readTextMs,
        `IR large ${label}: key to DOM change without the two readText calls`,
      ).toBeLessThan(LARGE_RESTORE_SHARE_MS)
      expect(
        step.keyToTaskEndMs,
        `IR large ${label}: key to the end of the Undo/Redo task`,
      ).not.toBeNull()
      expect(
        step.keyToTaskEndMs as number,
        `IR large ${label}: key to the end of the Undo/Redo task`,
      ).toBeLessThan(LARGE_TASK_MS)
    }
  })

  test('WYSIWYG: Undo and Redo restore the text and keep every unchanged block', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const { undo, redo } = await typeThenUndoRedo(
      evaluateInVSCode as HostEvaluator,
      workbox as Page,
      baseDir,
      'wysiwyg',
      smallDocument(),
      'block-restore-wysiwyg',
    )
    console.log(`[block-restore] wysiwyg ${JSON.stringify({ undo, redo })}`)
    expectOnlyEditReplaced(undo, 'WYSIWYG Undo')
    expectOnlyEditReplaced(redo, 'WYSIWYG Redo')
  })

  test('Split View: Undo and Redo restore the text exactly', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    // typeThenUndoRedo asserts the exact editor and host text after each step.
    const { undo, redo } = await typeThenUndoRedo(
      evaluateInVSCode as HostEvaluator,
      workbox as Page,
      baseDir,
      'sv',
      smallDocument(),
      'block-restore-sv',
    )
    console.log(`[block-restore] sv ${JSON.stringify({ undo, redo })}`)
  })
})
