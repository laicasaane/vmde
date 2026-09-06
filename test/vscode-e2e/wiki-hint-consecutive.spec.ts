import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

test('consecutive wiki completions preserve the first chip and authored separator', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(90_000)
  writeFileSync(path.join(baseDir, 'Home.md'), '# Home\n')
  writeFileSync(path.join(baseDir, 'Alpha.md'), '# Alpha\n')
  const docPath = path.join(baseDir, 'wiki-hint-consecutive.md')
  writeFileSync(docPath, '# Wiki hints\n\nStart\n')

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
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
    (state) => state.routerReady && state.editorEpoch > 0,
  )
  await frame.locator('.vditor-ir').getByText('Start').click()
  await frame.locator('body').evaluate(async () => {
    for (
      let index = 0;
      index < 300 && !(window as any).vditor?.vditor?.lute;
      index++
    )
      await new Promise((resolve) => setTimeout(resolve, 100))
    const paragraph = Array.from(
      document.querySelectorAll<HTMLElement>('.vditor-ir .vditor-reset > p'),
    ).find((item) => item.textContent?.includes('Start'))
    const text = paragraph?.firstChild
    if (!paragraph || !text) throw new Error('Start paragraph is unavailable')
    paragraph.closest<HTMLElement>('.vditor-ir')?.focus()
    const range = document.createRange()
    range.setStart(text, text.textContent?.length ?? 0)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })

  await workbox.keyboard.type(' [[Ho', { delay: 40 })
  const hint = frame.locator('.vditor-content > .vditor-hint')
  const homeChoice = hint.locator('button').filter({ hasText: 'Home' })
  await homeChoice.waitFor({ state: 'visible', timeout: 15_000 })
  await homeChoice.click()
  await workbox.keyboard.type('[[Al', { delay: 40 })
  const alphaChoice = hint.locator('button').filter({ hasText: 'Alpha' })
  await alphaChoice.waitFor({ state: 'visible', timeout: 15_000 })
  await alphaChoice.click()

  await expect
    .poll(
      () =>
        frame.locator('body').evaluate(() => (window as any).vditor.getValue()),
      { timeout: 15_000 },
    )
    .toContain('Start [[Home]] [[Alpha]]')
  const state = await frame.locator('body').evaluate(() => ({
    homeMissing: document
      .querySelector('.wiki-link-chip[data-wiki-target="Home"]')
      ?.hasAttribute('data-wiki-missing'),
    alphaMissing: document
      .querySelector('.wiki-link-chip[data-wiki-target="Alpha"]')
      ?.hasAttribute('data-wiki-missing'),
  }))
  expect(state).toEqual({ homeMissing: false, alphaMissing: false })

  await workbox.keyboard.press('Control+s')
  await expect
    .poll(
      () =>
        evaluateInVSCode(
          async (vscode: typeof import('vscode'), args: [string]) =>
            vscode.workspace.textDocuments
              .find((document) => document.uri.fsPath === args[0])
              ?.getText() ?? '',
          [docPath] as [string],
        ),
      { timeout: 15_000 },
    )
    .toContain('[[Home]] [[Alpha]]')
})
