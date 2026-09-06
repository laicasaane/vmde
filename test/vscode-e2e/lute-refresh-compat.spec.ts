import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

const SOURCE = path.join(__dirname, 'fixtures', 'lute-refresh-compat.md')
const TEMP = path.join(tmpdir(), 'vmde-lute-refresh-compat.md')

test('refreshed Lute preserves the compatibility corpus through all editor modes and save', async ({
  workbox,
  evaluateInVSCode,
}) => {
  const before = readFileSync(SOURCE, 'utf8')
  const expected = before.replace('EditSentinel', 'EditSentinelX')
  writeFileSync(TEMP, before)
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
    [TEMP] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(frame, (snapshot) => snapshot.editorEpoch > 0)

  const switchMode = async (mode: string) => {
    const beforeSwitch = await waitForE2EReadiness(frame, () => true)
    await frame.locator('body').evaluate((_body, targetMode) => {
      document
        .querySelector(`.vditor-toolbar button[data-mode="${targetMode}"]`)
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
    }, mode)
    await waitForE2EReadiness(
      frame,
      (snapshot) =>
        snapshot.modeEpoch > beforeSwitch.modeEpoch && snapshot.mode === mode,
    )
  }

  await switchMode('wysiwyg')
  await switchMode('sv')
  await switchMode('ir')
  await frame.locator('body').evaluate(() => {
    const root = document.querySelector('.vditor-ir') as HTMLElement
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf('EditSentinel') ?? -1
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index + 'EditSentinel'.length)
      range.collapse(true)
      const selection = getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.execCommand('insertText', false, 'X')
      return
    }
    throw new Error('EditSentinel not found')
  })

  await expect
    .poll(
      async () =>
        (await evaluateInVSCode(
          async (vscode: typeof import('vscode'), args: string[]) =>
            vscode.workspace.textDocuments
              .find((document) => document.uri.fsPath === args[0])
              ?.getText(),
          [TEMP] as [string],
        )) as string | undefined,
      { timeout: 15_000, intervals: [200, 300, 500, 800] },
    )
    .toBe(expected)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(TEMP, 'utf8')).toBe(expected)
  rmSync(TEMP, { force: true })
})
