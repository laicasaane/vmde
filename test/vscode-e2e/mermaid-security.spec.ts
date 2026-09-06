import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'mermaid-security.md')

test('advisory-affected Mermaid families render without prototype pollution', async ({
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
    .poll(() => frame.locator('.language-mermaid > svg').count(), {
      timeout: 60_000,
    })
    .toBe(3)

  const state = await frame.locator('body').evaluate(() => ({
    rendered: document.querySelectorAll('.language-mermaid > svg').length,
    errors: document.querySelectorAll('.language-mermaid .vmde-diagram-error')
      .length,
    polluted: Object.hasOwn(
      Object.prototype,
      'mermaidPrototypePollutionMarker',
    ),
  }))

  expect(state).toEqual({ rendered: 3, errors: 0, polluted: false })
})
