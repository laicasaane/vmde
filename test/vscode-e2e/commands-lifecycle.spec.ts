import { wf } from './webview-helpers'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// NET (task 190 P2) — the visual↔text editor command round-trip (J40 return-to-text, plus the
// custom-editor open). vmde.openTextEditor swaps the file into the default text editor;
// vmde.openEditor brings the custom (visual) editor back. When a custom editor is active there
// is NO activeTextEditor; when the text editor is active there IS one on the file — a clean signal.
const SRC = path.join(__dirname, 'fixtures', 'torture.md')

test('openTextEditor ↔ openEditor swaps between the text and visual editors', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(120_000)
  const tmp = path.join(tmpdir(), 'vmde-commands.md')
  writeFileSync(tmp, readFileSync(SRC, 'utf8'))
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [tmp] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 1000)))

  const activeTextPath = () =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode')) => {
        // Give VS Code a beat to settle the active editor after the command.
        await new Promise((r) => setTimeout(r, 500))
        return vscode.window.activeTextEditor?.document.uri.fsPath ?? null
      },
      [] as [],
    ) as Promise<string | null>

  // Custom editor active → no text editor.
  expect(await activeTextPath(), 'visual editor active → no text editor').toBe(
    null,
  )

  // Swap to the text editor on the same file.
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand(
        'vmde.openTextEditor',
        vscode.Uri.file(args[0]),
      )
    },
    [tmp] as [string],
  )
  expect(
    await activeTextPath(),
    'openTextEditor → text editor on the file',
  ).toBe(tmp)

  // Swap back to the visual editor.
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand(
        'vmde.openEditor',
        vscode.Uri.file(args[0]),
      )
    },
    [tmp] as [string],
  )
  expect(
    await activeTextPath(),
    'openEditor → visual editor back (no text editor)',
  ).toBe(null)
  rmSync(tmp, { force: true })
})
