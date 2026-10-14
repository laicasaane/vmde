import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 633: the code block copy button must copy on a real pointer press without letting the press
// reach the code block. Before the fix a held press in IR lost the copy (the native mousedown
// default moved the caret into the preview text, the selection-driven marker reveal expanded the
// block and hid the button before mouseup) and a fast click copied but still expanded the block
// and moved the caret (Vditor's IR root click handler). Real pointer input through the page-level
// mouse, the host clipboard and the host document are read back; nothing is read from the code
// under test.

const FIRST_BLOCK_TEXT = 'const a = 1;\nconst b = 2;'
const SECOND_BLOCK_TEXT = 'const c = 3;'
const SENTINEL = 'task-633-sentinel'
const CONTENT = [
  '# Copy button',
  '',
  'Intro paragraph.',
  '',
  '```js',
  FIRST_BLOCK_TEXT,
  '```',
  '',
  '```js',
  SECOND_BLOCK_TEXT,
  '```',
  '',
  'Final paragraph here.',
  '',
].join('\n')

type Mode = 'ir' | 'wysiwyg' | 'sv'
type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type Evaluate = (fn: unknown, args: unknown[]) => Promise<unknown>

interface WebviewState {
  selection: string
  expanded: number
  blocks: string[]
  undo: number
}

interface HostState {
  text: string
  dirty: boolean
}

async function openFixture(
  evaluateInVSCode: Evaluate,
  workbox: Page,
  baseDir: string,
  name: string,
  mode: Mode,
): Promise<{ frame: Frame; file: string }> {
  const file = path.join(baseDir, name)
  writeFileSync(file, CONTENT)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string, string, string]) => {
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [file, ExtensionId, MarkdownEditorViewType],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'code copy button IR readiness' },
  )
  await waitForInitialUndoSnapshot(frame)
  if (mode !== 'ir') {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator(`button[data-mode="${mode}"]`).click()
    await waitForE2EReadiness(frame, (state) => state.mode === mode, {
      message: `code copy button ${mode} readiness`,
    })
    await waitForInitialUndoSnapshot(frame)
  }
  return { frame, file }
}

const hostState = (evaluateInVSCode: Evaluate, file: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )
      return { text: doc?.getText() ?? '', dirty: doc?.isDirty ?? false }
    },
    [file],
  ) as Promise<HostState>

const readClipboard = (evaluateInVSCode: Evaluate) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode')) => vscode.env.clipboard.readText(),
    [],
  ) as Promise<string>

/** Caret, selection, expand flags, code block markup and Undo depth of the active edit mode. */
const webviewState = (frame: Frame, mode: Mode): Promise<WebviewState> =>
  frame.locator('body').evaluate((_body, editorMode) => {
    const selection = window.getSelection()
    const describe = (node: Node | null) =>
      node
        ? `${node.nodeName}:${(node.textContent ?? '').slice(0, 30)}`
        : 'none'
    const root = document.querySelector(`.vditor-${editorMode}`)
    const inner = (
      window as unknown as {
        vditor: {
          vditor: {
            currentMode: string
            undo: Record<string, { undoStack: unknown[] }>
          }
        }
      }
    ).vditor.vditor
    return {
      selection: JSON.stringify([
        describe(selection?.anchorNode ?? null),
        selection?.anchorOffset,
        describe(selection?.focusNode ?? null),
        selection?.focusOffset,
        selection?.isCollapsed,
      ]),
      expanded: root?.querySelectorAll('.vditor-ir__node--expand').length ?? 0,
      blocks: [
        ...(root?.querySelectorAll('[data-type="code-block"]') ?? []),
      ].map((block) => block.outerHTML),
      undo: inner.undo[inner.currentMode].undoStack.length,
    }
  }, mode)

async function placeCaretInFinalParagraph(frame: Frame, mode: Mode) {
  await frame
    .locator(`.vditor-${mode} p`)
    .filter({ hasText: 'Final paragraph here.' })
    .click()
  await expect
    .poll(async () => (await webviewState(frame, mode)).selection)
    .toContain('Final paragraph here.')
  // The click's own selection, marker and Undo bookkeeping is settled before the baseline is read.
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)))
}

async function armCopy(evaluateInVSCode: Evaluate, frame: Frame) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.env.clipboard.writeText(args[0])
    },
    [SENTINEL],
  )
  await frame.locator('body').evaluate(() => {
    const region = document.getElementById('vmde-live-region')
    if (region) region.textContent = ''
  })
}

/** Move onto the block so the button shows, then return the button centre in page coordinates. */
async function buttonCentre(frame: Frame, mode: Mode, index: number) {
  const block = frame.locator(`.vditor-${mode} [data-type="code-block"]`)
  await block.nth(index).hover()
  const button = frame
    .locator(`.vditor-${mode} .vditor-copy [data-vmde-copy-code="true"]`)
    .nth(index)
  await expect(button).toBeVisible()
  const box = await button.boundingBox()
  if (!box) throw new Error(`copy button ${index} has no box`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function expectCopied(
  evaluateInVSCode: Evaluate,
  frame: Frame,
  expected: string,
) {
  await expect
    .poll(() => readClipboard(evaluateInVSCode), {
      timeout: 15_000,
      intervals: [100, 250, 500],
    })
    .toBe(expected)
  await expect(frame.locator('#vmde-live-region')).toHaveText('Copied code', {
    timeout: 10_000,
  })
}

async function expectUnchanged(
  evaluateInVSCode: Evaluate,
  frame: Frame,
  file: string,
  mode: Mode,
  before: { web: WebviewState; host: HostState },
) {
  // Negative assertion: a late marker reveal frame would add the expand class, so give it room.
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)))
  const web = await webviewState(frame, mode)
  expect(web.expanded, 'no block expanded').toBe(0)
  expect(web.selection, 'caret and selection unchanged').toBe(
    before.web.selection,
  )
  expect(web.blocks, 'code block markup unchanged').toEqual(before.web.blocks)
  expect(web.undo, 'Undo depth unchanged').toBe(before.web.undo)
  const host = await hostState(evaluateInVSCode, file)
  expect(host.text, 'host bytes unchanged').toBe(before.host.text)
  expect(host.dirty, 'dirty state unchanged').toBe(before.host.dirty)
}

test('IR: a held press and a fast click on the copy button copy without expanding the block', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const evaluate = evaluateInVSCode as Evaluate
  const { frame, file } = await openFixture(
    evaluate,
    workbox,
    baseDir,
    'copy-ir.md',
    'ir',
  )
  await placeCaretInFinalParagraph(frame, 'ir')
  const baseline = {
    web: await webviewState(frame, 'ir'),
    host: await hostState(evaluate, file),
  }
  expect(baseline.host.text).toBe(CONTENT)
  expect(baseline.web.blocks, 'both code blocks rendered').toHaveLength(2)
  expect(baseline.host.dirty).toBe(false)
  expect(baseline.web.expanded).toBe(0)

  // Acceptance 2 and 3: held press (down, 150 ms, up) on the first block.
  await armCopy(evaluate, frame)
  const held = await buttonCentre(frame, 'ir', 0)
  await workbox.mouse.move(held.x, held.y)
  await workbox.mouse.down()
  await workbox.waitForTimeout(150)
  // The pre-fix reveal expanded the block within about 35 ms of mousedown, so the hold must not.
  expect((await webviewState(frame, 'ir')).expanded, 'during the hold').toBe(0)
  await workbox.mouse.up()
  await expectCopied(evaluate, frame, FIRST_BLOCK_TEXT)
  await expectUnchanged(evaluate, frame, file, 'ir', baseline)

  // Acceptance 2 and 3: fast click (down and up back to back) on the second block.
  await armCopy(evaluate, frame)
  const fast = await buttonCentre(frame, 'ir', 1)
  await workbox.mouse.click(fast.x, fast.y)
  await expectCopied(evaluate, frame, SECOND_BLOCK_TEXT)
  await expectUnchanged(evaluate, frame, file, 'ir', baseline)

  // Acceptance 5: a click on the code text elsewhere in the block still enters editing in IR.
  await armCopy(evaluate, frame)
  await frame
    .locator('.vditor-ir__preview code')
    .first()
    .click({ position: { x: 6, y: 6 } })
  await expect
    .poll(async () => (await webviewState(frame, 'ir')).expanded)
    .toBe(1)
  expect(await readClipboard(evaluate), 'text click copies nothing').toBe(
    SENTINEL,
  )
})

test('WYSIWYG: a held press on the copy button copies with the caret unchanged', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const evaluate = evaluateInVSCode as Evaluate
  const { frame, file } = await openFixture(
    evaluate,
    workbox,
    baseDir,
    'copy-wysiwyg.md',
    'wysiwyg',
  )
  await placeCaretInFinalParagraph(frame, 'wysiwyg')
  const baseline = {
    web: await webviewState(frame, 'wysiwyg'),
    host: await hostState(evaluate, file),
  }
  expect(baseline.host.text).toBe(CONTENT)
  expect(baseline.web.blocks, 'both code blocks rendered').toHaveLength(2)

  // Acceptance 5 (decision 1: one shared handler, so WYSIWYG keeps its caret too).
  await armCopy(evaluate, frame)
  const held = await buttonCentre(frame, 'wysiwyg', 0)
  await workbox.mouse.move(held.x, held.y)
  await workbox.mouse.down()
  await workbox.waitForTimeout(150)
  await workbox.mouse.up()
  await expectCopied(evaluate, frame, FIRST_BLOCK_TEXT)
  await expectUnchanged(evaluate, frame, file, 'wysiwyg', baseline)
})

test('SV preview: the copy button still copies the exact code text', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const evaluate = evaluateInVSCode as Evaluate
  const { frame, file } = await openFixture(
    evaluate,
    workbox,
    baseDir,
    'copy-sv.md',
    'sv',
  )
  const preview = frame.locator('.vditor-preview')
  await expect(preview.locator('pre > code').first()).toContainText('const a')
  const before = await hostState(evaluate, file)
  expect(before.text).toBe(CONTENT)

  // Acceptance 5: SV preview copy unchanged.
  await armCopy(evaluate, frame)
  await preview.locator('pre').first().hover()
  const button = preview
    .locator('.vditor-copy [data-vmde-copy-code="true"]')
    .first()
  await expect(button).toBeVisible()
  await button.click()
  await expectCopied(evaluate, frame, FIRST_BLOCK_TEXT)
  const after = await hostState(evaluate, file)
  expect(after.text, 'host bytes unchanged').toBe(before.text)
  expect(after.dirty, 'dirty state unchanged').toBe(before.dirty)
})
