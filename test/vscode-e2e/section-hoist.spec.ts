import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

const ORIGINAL = [
  '# Chapter',
  '',
  'Chapter introduction.',
  '',
  '## Child',
  '',
  'Editable child detail.',
  '',
  '## Sibling',
  '',
  'Sibling detail.',
  '',
  '# Next chapter',
  '',
  'Hidden find target VMDE_HOIST_FIND_TARGET.',
  '',
].join('\n')

test('hoisted editing saves the full file and exits before find reveals a hidden target', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'section-hoist.md')
  writeFileSync(file, ORIGINAL)
  await evaluateInVSCode(
    async (vscode, args: string[]) => {
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
    { message: 'section-hoist editor readiness' },
  )
  const outline = frame.locator('.vditor-outline')
  if (!(await outline.isVisible())) {
    await frame.locator('body').evaluate(() => {
      const inner = (window as any).vditor.vditor
      inner.toolbar.elements.outline?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
    })
    await expect(outline).toBeVisible()
  }
  await frame
    .locator('.vditor-outline [data-target-id]')
    .filter({ hasText: 'Child' })
    .click({ button: 'right' })
  await frame.getByRole('menuitem', { name: 'Hoist section' }).click()

  await expect(
    frame.getByRole('navigation', { name: 'Hoisted section' }),
  ).toHaveText('Doc › Chapter › Child')
  await expect(
    frame.locator('.vditor-ir > .vditor-reset > [data-block]:visible'),
  ).toHaveCount(2)
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.getValue()),
  ).toBe(ORIGINAL)

  const detail = frame
    .locator('.vditor-ir > .vditor-reset > p:visible')
    .filter({ hasText: 'Editable child detail.' })
  await detail.click()
  await workbox.keyboard.press('End')
  await workbox.keyboard.type(' changed')
  const edited = ORIGINAL.replace(
    'Editable child detail.',
    'Editable child detail. changed',
  )
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(edited)

  // The production key router owns webview undo. Its 800 ms snapshot delay must settle first.
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 900)))
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(ORIGINAL)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(edited)

  await evaluateInVSCode(
    async (vscode, args: string[]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === args[0],
      )
      if (!document || !(await document.save())) {
        throw new Error('failed to save hoisted document')
      }
    },
    [file] as [string],
  )
  expect(readFileSync(file, 'utf8')).toBe(edited)

  await detail.click()
  await workbox.keyboard.press('Control+f')
  await expect(frame.locator('[data-vmde-hoist-hidden]')).toHaveCount(0)
  await expect(
    frame.getByText('Hidden find target VMDE_HOIST_FIND_TARGET.'),
  ).toBeVisible()
})
