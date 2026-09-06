import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

const value = (frame: ReturnType<typeof wf>) =>
  frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue() as string)

const markers = async (frame: ReturnType<typeof wf>) => {
  const text = await value(frame)
  return {
    before: text.includes('before'),
    paste: text.includes('PASTED'),
    after: text.includes('after'),
  }
}

test('typing, a real paste, and following typing undo as three disk-safe steps', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'undo-boundaries.md')
  const initial = 'base\n'
  writeFileSync(file, initial)
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'undo-boundary fixture readiness' },
  )
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 1_000)))
  const baseline = await value(frame)
  await frame.locator('.vditor-ir').click()
  await workbox.keyboard.press('Control+End')
  await workbox.keyboard.type('before')
  await evaluateInVSCode(
    async (vscode) => vscode.env.clipboard.writeText('PASTED'),
    [file] as [string],
  )
  await workbox.keyboard.press('Control+V')
  await expect.poll(() => value(frame)).toContain('PASTED')
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)))
  await workbox.keyboard.press('Control+End')
  await workbox.keyboard.type('after')
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 1_000)))
  expect(await value(frame)).toContain('PASTEDafter')

  await workbox.keyboard.press('Control+Z')
  await expect
    .poll(() => markers(frame))
    .toEqual({
      before: true,
      paste: true,
      after: false,
    })
  await workbox.keyboard.press('Control+Z')
  await expect
    .poll(() => markers(frame))
    .toEqual({
      before: true,
      paste: false,
      after: false,
    })
  await workbox.keyboard.press('Control+Z')
  await expect.poll(() => value(frame)).toBe(baseline)

  await workbox.keyboard.press('Control+S')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(initial)
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(initial)
})
