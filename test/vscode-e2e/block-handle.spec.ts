import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const ORIGINAL = 'alpha\n\n```ts\nconst x = 1\n```\n\nomega\n'
const MOVED = '```ts\nconst x = 1\n```\n\nalpha\n\nomega\n'

test('real block handle moves a paragraph across a fence through one exact host transaction', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'block-handle.md')
  writeFileSync(file, ORIGINAL)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  let frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      timeout: 60_000,
      message: 'block handle editor readiness',
    },
  )
  await frame.locator('.vditor-ir .vditor-reset > p').first().hover()
  const handle = frame.locator('.vmde-block-handle')
  await expect(handle).toBeVisible()
  await frame.locator('body').evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const fence = document.querySelector('.vditor-ir [data-type="code-block"]')!
    const data = new DataTransfer()
    handle.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = fence.getBoundingClientRect()
    fence.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
    fence.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
  })
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(MOVED)
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(ORIGINAL)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(MOVED)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(MOVED)
  frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await waitForE2EReadiness(frame, (state) => state.routerReady, {
    timeout: 60_000,
    message: 'reopened block handle editor readiness',
  })
  expect(readFileSync(file, 'utf8')).toBe(MOVED)
})
