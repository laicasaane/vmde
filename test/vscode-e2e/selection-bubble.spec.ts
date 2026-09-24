import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

const BEFORE = 'alpha\n\nbeta\n'

test('hidden-toolbar selection bubble formats, transforms, and preserves real host history', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'selection-bubble.md')
  writeFileSync(file, BEFORE)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.toolbar', false, vscode.ConfigurationTarget.Global)
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.selectionToolbar',
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
    [file] as [string],
  )
  try {
    const frame = wf(workbox)
    await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.mode === 'ir',
      {
        message: 'selection bubble hidden-toolbar readiness',
      },
    )
    await expect(
      frame.locator('.vditor-toolbar [data-type="bold"]'),
    ).toHaveCount(0)
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(
            () =>
              (window as any).vditor.vditor.undo.ir.undoStack.length as number,
          ),
      )
      .toBeGreaterThan(0)
    const undoBefore = await frame
      .locator('body')
      .evaluate(
        () => (window as any).vditor.vditor.undo.ir.undoStack.length as number,
      )
    await frame
      .locator('.vditor-ir .vditor-reset > p')
      .first()
      .evaluate((element) => {
        const text = element.firstChild!
        const range = document.createRange()
        range.setStart(text, 0)
        range.setEnd(text, 5)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
    const bubble = frame.locator('.vmde-selection-bubble')
    await expect(bubble).toBeVisible()
    const geometry = await bubble.evaluate((element) => {
      const bubble = element.getBoundingClientRect()
      const range = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
      return {
        bubbleBottom: bubble.bottom,
        bubbleTop: bubble.top,
        selectionTop: range.top,
        selectionBottom: range.bottom,
        insideEditor: Boolean(element.closest('.vditor-reset')),
      }
    })
    expect(geometry.insideEditor).toBe(false)
    expect(
      geometry.bubbleBottom <= geometry.selectionTop ||
        geometry.bubbleTop >= geometry.selectionBottom,
    ).toBe(true)
    await bubble.getByRole('button', { name: 'Bold' }).click()
    const bold = '**alpha**\n\nbeta\n'
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(bold)
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(
            () =>
              (window as any).vditor.vditor.undo.ir.undoStack.length as number,
          ),
      )
      .toBeGreaterThan(undoBefore)
    await frame
      .locator('.vditor-ir')
      .first()
      .click({ position: { x: 4, y: 4 } })
    await workbox.keyboard.press('Control+z')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(BEFORE)
    await workbox.keyboard.press('Control+y')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(bold)
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    })
    expect(readFileSync(file, 'utf8')).toBe(bold)
    await frame
      .locator('.vditor-ir .vditor-reset > p')
      .last()
      .evaluate((element) => {
        const text = element.firstChild!
        const range = document.createRange()
        range.setStart(text, 0)
        range.setEnd(text, 4)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
    await expect(bubble).toBeVisible()
    await bubble.getByRole('button', { name: 'Turn Into' }).click()
    const menu = bubble.locator('.vmde-selection-bubble-menu')
    await expect(
      menu.getByRole('menuitemradio', { name: '✓ Paragraph' }),
    ).toHaveAttribute('aria-checked', 'true')
    await menu.getByRole('menuitemradio', { name: 'Heading 2' }).click()
    const transformed = '**alpha**\n\n## beta\n'
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(transformed)
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    })
    expect(readFileSync(file, 'utf8')).toBe(transformed)
  } finally {
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.toolbar', undefined, vscode.ConfigurationTarget.Global)
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.selectionToolbar',
          undefined,
          vscode.ConfigurationTarget.Global,
        )
    })
  }
})
