import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

test('More Insert anchor preserves prose and rejects a duplicate target', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const docPath = path.join(baseDir, 'named-anchor.md')
  writeFileSync(docPath, 'before selected prose after\n')
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
    document.dispatchEvent(new Event('vmde-insert-named-anchor'))
  })
  const dialog = frame.locator('[data-vmde-anchor-dialog]')
  await dialog.locator('input').fill('custom')
  await dialog.locator('button[type="submit"]').click()
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => (window as any).vditor.getValue() as string),
    )
    .toContain('<a name="custom"></a>')

  await frame.locator('body').evaluate(() => {
    document.dispatchEvent(new Event('vmde-insert-named-anchor'))
  })
  await dialog.locator('input').fill('custom')
  await dialog.locator('button[type="submit"]').click()
  await expect(dialog.locator('[data-vmde-anchor-error]')).toContainText(
    'already exists',
  )
})
