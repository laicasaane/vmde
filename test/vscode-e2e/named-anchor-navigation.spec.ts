import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

test('More Insert anchor preserves prose and rejects a duplicate target', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const docPath = path.join(baseDir, 'named-anchor.md')
  const initial = 'before selected prose after\r\n'
  const inserted = 'before <a name="custom"></a>selected prose after\r\n'
  writeFileSync(docPath, initial)
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'named-anchor fixture readiness' },
  )

  await frame.locator('body').evaluate(() => {
    const paragraph = document.querySelector('.vditor-ir p')!
    const text = paragraph.firstChild!
    const range = document.createRange()
    range.setStart(text, 'before '.length)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    ;(window as any).vditor.vditor.ir.range = range.cloneRange()
  })
  await frame.locator('.vditor-toolbar [data-type="more"]').click()
  await frame.locator('[data-type="insert-anchor"]').click()
  const dialog = frame.locator('[data-vmde-anchor-dialog]')
  await dialog.locator('input').fill('custom')
  await dialog.locator('button[type="submit"]').click()
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => (window as any).vditor.getValue() as string),
    )
    .toBe(inserted.replace('\r\n', '\n'))
  await expect.poll(() => docText(evaluateInVSCode, docPath)).toBe(inserted)

  await frame.locator('body').evaluate(() => {
    const outer = (window as any).vditor
    outer.vditor.undo.undo(outer.vditor)
  })
  await expect.poll(() => docText(evaluateInVSCode, docPath)).toBe(initial)
  await frame.locator('body').evaluate(() => {
    const outer = (window as any).vditor
    outer.vditor.undo.redo(outer.vditor)
  })
  await expect.poll(() => docText(evaluateInVSCode, docPath)).toBe(inserted)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(docPath, 'utf8')).toBe(inserted)

  await frame.locator('.vditor-toolbar [data-type="more"]').click()
  await frame.locator('[data-type="insert-anchor"]').click()
  await dialog.locator('input').fill('custom')
  await dialog.locator('button[type="submit"]').click()
  await expect(dialog.locator('[data-vmde-anchor-error]')).toContainText(
    'already exists',
  )
})
