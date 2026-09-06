import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

const INITIAL = [
  'alpha **target alpha** omega',
  '',
  '```txt',
  'alpha fence',
  '```',
  '',
  '| A | B |',
  '| --- | --- |',
  '| alpha | tail |',
].join('\n')

const getValue = (frame: ReturnType<typeof wf>) =>
  frame
    .locator('body')
    .evaluate(() =>
      (
        window as unknown as { vditor: { getValue(): string } }
      ).vditor.getValue(),
    )

test('Ctrl+F opens source-accurate replace; replace-all undoes once and replace saves', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const docPath = path.join(baseDir, 'find-replace.md')
  writeFileSync(docPath, INITIAL)
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
    { message: 'find/replace fixture readiness' },
  )
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 8, y: 8 } })
  const baseline = await getValue(frame)

  await workbox.keyboard.press('Control+f')
  const widget = frame.locator('.vmde-find-replace')
  await expect(widget).toBeVisible({ timeout: 10_000 })
  await expect(widget.locator('[data-find]')).toBeFocused()
  await widget.locator('[data-find]').fill('alpha')
  await expect(widget.locator('[data-status]')).toHaveText('1/4')
  await expect(frame.locator('.vmde-find-overlay').first()).toBeVisible()
  await widget.locator('[data-replace]').fill('beta')
  await widget.locator('[data-action="replace-all"]').click()
  await expect.poll(() => getValue(frame)).not.toMatch(/\balpha\b/)
  expect(await getValue(frame)).toContain('**target beta**')

  await widget.locator('[data-find]').press('Escape')
  await expect(widget).toBeHidden()
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => getValue(frame)).toBe(baseline)

  // Ctrl+H remains the promoted Headings shortcut; Task 196 does not steal it for replace.
  await workbox.keyboard.press('Control+h')
  const headings = frame
    .locator('.vditor-toolbar [data-type="headings"]')
    .locator('..')
    .locator('.vditor-hint')
  await expect(headings).toBeVisible({ timeout: 5_000 })
  await workbox.keyboard.press('Escape')

  await workbox.keyboard.press('Control+f')
  await expect(widget).toBeVisible()
  await widget.locator('[data-find]').fill('target alpha')
  await widget.locator('[data-replace]').fill('saved phrase')
  await widget.locator('[data-action="replace"]').click()
  await expect
    .poll(() => getValue(frame))
    .toContain('alpha **saved phrase** omega')
  await widget.locator('[data-find]').press('Escape')
  await workbox.keyboard.press('Control+s')
  await expect
    .poll(() => readFileSync(docPath, 'utf8'))
    .toContain('alpha **saved phrase** omega')
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => getValue(frame)).toBe(baseline)
})
