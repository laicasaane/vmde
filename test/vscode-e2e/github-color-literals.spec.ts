import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const original = [
  'Color #0969DA; retain RGB rgb(9, 105, 218) and HSL hsl(212, 92%, 45%).',
  '',
].join('\r\n')
const wrapped = original.replace('Color #0969DA', 'Color `#0969DA`')

async function selectText(
  frame: ReturnType<typeof wf>,
  needle: string,
): Promise<void> {
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 8, y: 8 } })
  await frame.locator('body').evaluate((_body, text) => {
    const root = document.querySelector('.vditor-ir')
    if (!root) throw new Error('IR editor is missing')
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let next = walker.nextNode(); next; next = walker.nextNode()) {
      const node = next as Text
      const offset = node.data.indexOf(text as string)
      if (offset < 0) continue
      const selection = getSelection()
      if (!selection) throw new Error('selection is unavailable')
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset + (text as string).length)
      selection.removeAllRanges()
      selection.addRange(range)
      return
    }
    throw new Error(`text not found in IR: ${text}`)
  }, needle)
}

async function undoStackLength(frame: ReturnType<typeof wf>): Promise<number> {
  return frame.locator('body').evaluate(() => {
    const inner = (window as unknown as { vditor: { vditor: any } }).vditor
      .vditor
    return inner.undo[inner.currentMode].undoStack.length as number
  })
}

test('XTEST Inline code swatch stays source-faithful through one undo/redo, save, Preview, and reopen', async ({
  electronApp,
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires the explicit XTEST runner',
  )
  test.setTimeout(150_000)
  const file = path.join(baseDir, 'github-color-literals.md')
  writeFileSync(file, original)
  const previousSetting = (await evaluateInVSCode(
    async (vscode: typeof import('vscode')) =>
      JSON.stringify({
        value:
          vscode.workspace
            .getConfiguration('vmde')
            .inspect<boolean>('github.colorLiterals')?.globalValue ?? null,
        wasSet:
          vscode.workspace
            .getConfiguration('vmde')
            .inspect<boolean>('github.colorLiterals')?.globalValue !==
          undefined,
      }),
    [],
  )) as string

  try {
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update(
            'github.colorLiterals',
            true,
            vscode.ConfigurationTarget.Global,
          )
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
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.mode === 'ir',
      { message: 'color literal editor readiness' },
    )
    // Vditor's opening undo snapshot is debounced by undoDelay; let it settle before measuring
    // the toolbar action's stack growth, as the shared undo-redo spec does.
    await frame
      .locator('body')
      .evaluate(() => new Promise((resolve) => setTimeout(resolve, 1_500)))
    const openingUndoStackLength = await undoStackLength(frame)
    expect(openingUndoStackLength).toBeGreaterThan(0)

    const xtest = await createXtestInput(electronApp, workbox)
    expect(xtest.client.visible).toBe(true)
    await selectText(frame, '#0969DA')
    const inlineCode = frame.locator(
      '.vditor-toolbar button[data-type="inline-code"]',
    )
    await expect(inlineCode).toBeVisible()
    await inlineCode.click()

    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(wrapped)
    const swatch = frame.locator('.vditor-ir code.vmde-github-color-literal')
    await expect(swatch).toHaveCount(1)
    await expect(swatch).toHaveText('#0969DA')
    expect(
      await swatch.evaluate(
        (code) => getComputedStyle(code, '::before').backgroundColor,
      ),
    ).toBe('rgb(9, 105, 218)')

    await expect
      .poll(() => undoStackLength(frame), {
        timeout: 5_000,
        message: 'inline-code toolbar action enters Vditor undo history',
      })
      .toBeGreaterThan(openingUndoStackLength)
    await frame
      .locator('.vditor-ir')
      .first()
      .click({ position: { x: 4, y: 4 } })
    await xtest.key('ctrl+z')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(original)
    const redoButton = frame.locator('.vditor-toolbar [data-type="redo"]')
    await expect(redoButton).not.toHaveClass(/vditor-menu--disabled/)
    await frame
      .locator('.vditor-ir')
      .first()
      .click({ position: { x: 4, y: 4 } })
    await xtest.key('ctrl+y')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(wrapped)

    const previewButton = frame.locator(
      '.vditor-toolbar button[data-type="preview"]',
    )
    await expect(previewButton).toBeVisible()
    await previewButton.click()
    const preview = frame.locator('.vditor-preview .vditor-reset')
    await expect(preview.locator('code.vmde-github-color-literal')).toHaveCount(
      1,
    )
    expect(
      await preview
        .locator('code.vmde-github-color-literal')
        .evaluate((code) => getComputedStyle(code, '::before').backgroundColor),
    ).toBe('rgb(9, 105, 218)')
    await previewButton.click()

    await xtest.key('ctrl+s')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(wrapped)
    await expect.poll(() => readFileSync(file, 'utf8')).toBe(wrapped)

    const reopened = await reopenVmdeFixture(
      evaluateInVSCode,
      workbox,
      file,
      60_000,
      '.vditor-ir',
    )
    await waitForE2EReadiness(
      reopened,
      (state) => state.routerReady && state.mode === 'ir',
      { message: 'reopened color literal editor readiness' },
    )
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(wrapped)
    await expect(
      reopened.locator('.vditor-ir code.vmde-github-color-literal'),
    ).toHaveText('#0969DA')
    await expect.poll(() => readFileSync(file, 'utf8')).toBe(wrapped)
  } finally {
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        const previous = JSON.parse(args[0]) as {
          value: boolean | null
          wasSet: boolean
        }
        await vscode.workspace
          .getConfiguration('vmde')
          .update(
            'github.colorLiterals',
            previous.wasSet ? previous.value : undefined,
            vscode.ConfigurationTarget.Global,
          )
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      },
      [previousSetting],
    )
    rmSync(file, { force: true })
  }
})
