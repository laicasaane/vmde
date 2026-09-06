import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const DIR = path.join(tmpdir(), 'vmde-task-212')
const DOC = path.join(DIR, 'widgets.md')

const frameFor = (workbox: import('@playwright/test').Page) =>
  workbox
    .frameLocator('iframe.webview')
    .frameLocator('iframe[title="VMDE"], #active-frame')

test('CSP-safe image and code widgets neither lock scrolling nor lose copy', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  writeFileSync(
    DOC,
    '# Widgets\n\n![image](https://example.invalid/never-loads.png)\n\n```ts\nconst copyMe = 42;\n```\n',
  )
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.codeLineNumbers',
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
    [DOC] as [string],
  )
  const frame = frameFor(workbox)
  const image = frame.locator('.vditor-ir img').first()
  await image.waitFor({ timeout: 60_000 })
  await image.dblclick()
  await expect(frame.locator('.vditor-img')).toHaveCount(0)
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => document.body.style.overflow),
    )
    .toBe('')

  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.env.clipboard.writeText('task-212-sentinel')
  })
  const codeBlock = frame
    .locator('.vditor-ir__preview')
    .filter({ hasText: 'copyMe' })
  await codeBlock.hover()
  await frame
    .locator('.vditor-ir .vditor-copy [data-vmde-copy-code="true"]')
    .first()
    .click()
  await expect
    .poll(
      () =>
        evaluateInVSCode(async (vscode: typeof import('vscode')) =>
          vscode.env.clipboard.readText(),
        ),
      { timeout: 15_000, intervals: [250, 500, 1000] },
    )
    // Vditor prepends visual line numbers in this mode. The custom copy bridge must use the
    // underlying code textarea, not the rendered gutter, or users get "1 const copyMe...".
    .toBe('const copyMe = 42;')
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update(
        'editor.codeLineNumbers',
        undefined,
        vscode.ConfigurationTarget.Global,
      )
  })
  rmSync(DIR, { recursive: true, force: true })
})
