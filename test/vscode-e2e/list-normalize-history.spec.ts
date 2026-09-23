import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

const INITIAL = [
  '3. first',
  '9. stale first',
  '',
  'prose',
  '',
  '4) second',
  '9) stale second',
  '',
  'more prose',
  '',
  '7. third',
  '9. stale third',
  '',
].join('\n')
const AFTER_FIX = INITIAL.replace('9. stale first', '4. stale first')
const AFTER_ALL = AFTER_FIX.replace(
  '9) stale second',
  '5) stale second',
).replace('9. stale third', '8. stale third')

async function sourceCaret(frame: ReturnType<typeof wf>, needle: string) {
  await frame.locator('body').evaluate((_body, text) => {
    const root = (window as any).vditor.vditor.sv.element as HTMLElement
    const offset = (root.textContent ?? '').indexOf(text) + 2
    if (offset < 2) throw new Error(`source caret target ${text} missing`)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let remaining = offset
    for (
      let node = walker.nextNode() as Text | null;
      node;
      node = walker.nextNode() as Text | null
    ) {
      if (remaining <= node.length) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        root.focus()
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      remaining -= node.length
    }
    throw new Error(`source caret target ${text} missing`)
  }, needle)
}

test('palette Fix then All uses one native Undo and Redo for byte-different list states', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'list-normalize-history.md')
  writeFileSync(file, INITIAL)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
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
    { timeout: 60_000 },
  )
  await frame.locator('body').evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document.querySelector<HTMLButtonElement>('button[data-mode="sv"]')?.click()
  })
  await waitForE2EReadiness(frame, (state) => state.mode === 'sv', {
    timeout: 60_000,
  })
  expect(await docText(evaluateInVSCode, file)).toBe(INITIAL)

  async function invokePalette(title: string) {
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.showCommands')
    })
    const input = workbox.locator('.quick-input-widget input').first()
    await expect(input).toBeVisible()
    await input.fill(`>VMDE: ${title}`)
    await expect(
      workbox.getByRole('option', { name: new RegExp(title) }).first(),
    ).toBeVisible()
    await input.press('Enter')
  }

  await sourceCaret(frame, 'stale first')
  await invokePalette('Fix List Numbering')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(AFTER_FIX)
  await sourceCaret(frame, 'prose')
  await invokePalette('Renormalize All Lists')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(AFTER_ALL)

  // Keep the focus transfer real: the commands run through VS Code's native palette,
  // then one trusted keyboard Undo/Redo must move the source model by one batch.
  await frame.locator('.vditor-sv').first().focus()
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(AFTER_FIX)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(AFTER_ALL)

  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(AFTER_ALL)
})
