import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const BEFORE = 'before\n\nalpha **beta**\n\nafter\n'
const AFTER = 'before\n\n## alpha **beta**\n\nafter\n'

async function placeIrCaret(frame: ReturnType<typeof wf>, needle: string) {
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await frame.locator('body').evaluate((_body, text) => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (
      let node = walker.nextNode() as Text | null;
      node;
      node = walker.nextNode() as Text | null
    ) {
      const index = node.data.indexOf(text)
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index + 2)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      root.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return
    }
    throw new Error(`Turn Into caret target ${text} missing`)
  }, needle)
}

test('native Turn Into QuickPick uses retained source target, one undo, and exact save', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'block-transform.md')
  writeFileSync(file, BEFORE)
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
      message: 'Turn Into editor readiness',
    },
  )
  await placeIrCaret(frame, 'beta')
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('vmde.turnInto')
  })
  const picker = workbox.locator('.quick-input-widget input').first()
  await expect(picker).toBeVisible()
  await picker.press('Escape')
  expect(await docText(evaluateInVSCode, file)).toBe(BEFORE)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('vmde.turnInto')
  })
  await expect(picker).toBeVisible()
  await expect(
    workbox.getByRole('option', { name: /Heading 2/u }).first(),
  ).toBeVisible()
  await picker.fill('Heading 2')
  await picker.press('Enter')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(AFTER)

  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(BEFORE)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(AFTER)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(AFTER)
  frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await waitForE2EReadiness(frame, (state) => state.routerReady, {
    timeout: 60_000,
    message: 'reopened Turn Into editor readiness',
  })
  expect(readFileSync(file, 'utf8')).toBe(AFTER)
})

test('native context entry remains selection-driven under an untrusted clicked-node argument', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)
  const file = path.join(baseDir, 'block-transform-context.md')
  const before = 'alpha **beta**\n\n```ts\nconst x = 1\n```\n'
  const after = '> alpha **beta**\n\n```ts\nconst x = 1\n```\n'
  writeFileSync(file, before)
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
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      timeout: 60_000,
      message: 'Turn Into context readiness',
    },
  )
  await expect(frame.locator('#app')).toHaveAttribute(
    'data-vscode-context',
    '{"webviewSection":"editor"}',
  )
  await expect(
    frame.locator('.vditor-ir [data-type="code-block"] pre').first(),
  ).toHaveAttribute('data-vscode-context', '{"webviewSection":"code"}')
  await placeIrCaret(frame, 'beta')
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    // Task 215's real native menu cannot be clicked by Playwright. This direct-command
    // proxy proves the forged clicked-node argument does not override the editor selection.
    await vscode.commands.executeCommand('vmde.turnInto', {
      webviewSection: 'diagram',
      lang: 'mermaid',
    })
  })
  const picker = workbox.locator('.quick-input-widget input').first()
  await expect(picker).toBeVisible()
  await expect(
    workbox.getByRole('option', { name: /Paragraph/u }).first(),
  ).toBeVisible()
  await picker.fill('Quote')
  await picker.press('Enter')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
})
