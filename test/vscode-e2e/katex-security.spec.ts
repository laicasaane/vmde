import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'katex-security.md')

test('KaTeX 0.16.47 renders valid families and rejects edef without blocking', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await evaluateInVSCode(
    async (vscode, args) => {
      const [uri] = args as [string]
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [FIXTURE] as [string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await expect
    .poll(
      () =>
        frame.locator('body').evaluate(() => ({
          rendered: document.querySelectorAll('.katex').length,
          errors: document.querySelectorAll('.katex-error').length,
        })),
      { timeout: 60_000 },
    )
    .toEqual({ rendered: 4, errors: 1 })

  const state = await frame.locator('body').evaluate(() => {
    const error = document.querySelector('.katex-error') as HTMLElement | null
    return {
      source: error?.textContent ?? '',
      color: error ? getComputedStyle(error).color : '',
      chemistry: [
        ...document.querySelectorAll<HTMLElement>('[data-math]'),
      ].some((element) => element.dataset.math?.includes('\\ce{H2O')),
      macro: [...document.querySelectorAll<HTMLElement>('[data-math]')].some(
        (element) => element.dataset.math?.includes('\\def\\RR'),
      ),
    }
  })
  expect(state.source).toContain('\\edef')
  expect(state.color).not.toBe('')
  expect(state.chemistry).toBe(true)
  expect(state.macro).toBe(true)

  await expect
    .poll(
      () =>
        frame.locator('body').evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              requestAnimationFrame(() => resolve(true))
            }),
        ),
      { timeout: 10_000 },
    )
    .toBe(true)
})
