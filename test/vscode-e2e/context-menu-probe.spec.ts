import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  ExtensionId,
  MarkdownEditorViewType,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const INITIAL = '# Root\n\n## Child\n'

test('context-menu visibility stamps leave shipped commands selection-driven', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  const file = path.join(baseDir, 'context-menu-probe.md')
  writeFileSync(file, INITIAL)
  const commands = (await evaluateInVSCode(
    async (vscode, args: [string, string, string]) => {
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
      return (await vscode.commands.getCommands(true)).filter((command) =>
        [
          'vmde.promoteHeading',
          'vmde.demoteHeading',
          'vmde.rewrap',
          'vmde.rewrapDocument',
        ].includes(command),
      )
    },
    [file, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )) as string[]
  expect(commands).toEqual([
    'vmde.promoteHeading',
    'vmde.demoteHeading',
    'vmde.rewrap',
    'vmde.rewrapDocument',
  ])

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { message: 'context command probe readiness' },
  )
  await expect(frame.locator('#app')).toHaveAttribute(
    'data-vscode-context',
    '{"webviewSection":"editor"}',
  )
  await frame.locator('body').evaluate(() => {
    const child = [...document.querySelectorAll('h1,h2,h3')].find((heading) =>
      heading.textContent?.includes('Child'),
    )!
    const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT)
    let text: Text | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('.vditor-ir__marker')) continue
      if (node.textContent?.includes('Child')) {
        text = node as Text
        break
      }
    }
    if (!text) throw new Error('Child heading text missing')
    const range = document.createRange()
    range.setStart(text, 2)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    ;(document.querySelector('.vditor-ir') as HTMLElement).focus()
  })

  await evaluateInVSCode(async (vscode) => {
    // This is the L3 direct-command proxy: Playwright cannot click Electron's native
    // context menu. A forged object reaches executeCommand only because the proxy supplies it;
    // the menu contribution itself has no target-argument contract to rely on.
    await vscode.commands.executeCommand('vmde.demoteHeading', {
      webviewSection: 'diagram',
      lang: 'mermaid',
    })
  })
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(INITIAL.replace('## Child', '### Child'))
  await frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    document.querySelector<HTMLButtonElement>('button[data-mode="sv"]')?.click()
  })
  await frame.locator('.vditor-sv').waitFor({ timeout: 30_000 })
  await waitForE2EReadiness(frame, (state) => state.mode === 'sv', {
    message: 'context-menu SV readiness',
  })
  await expect(frame.locator('.vditor-sv')).toHaveAttribute(
    'data-vscode-context',
    '{"webviewSection":"editor"}',
  )
  await frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    document.querySelector<HTMLButtonElement>('button[data-mode="ir"]')?.click()
  })
  await waitForE2EReadiness(frame, (state) => state.mode === 'ir', {
    message: 'context-menu IR return readiness',
  })
  // The direct host proxy cannot model Electron's native menu focus transfer. Existing
  // heading-level real-webview coverage owns the keyboard/caret contract; this L3 path proves
  // only that a forged context object does not become a clicked-node target.
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(
    INITIAL.replace('## Child', '### Child'),
  )
  const reopened = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await expect(reopened.locator('#app')).toHaveAttribute(
    'data-vscode-context',
    '{"webviewSection":"editor"}',
  )
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(INITIAL.replace('## Child', '### Child'))
})
