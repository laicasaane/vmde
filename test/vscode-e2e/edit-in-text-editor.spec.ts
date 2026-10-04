import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

// Task 580 CP2-8 — Edit in Text Editor (`vmde.openTextEditor`) is unbound and is the only route to
// the old Ctrl+Alt+E behavior: with a VMDE panel, it opens the source and selects the caret's line
// (the `edit-in-vscode` path, src/session/reveal-caret.ts). The webview's Ctrl+Alt+E listener is
// gone, so the key no longer opens anything.
const CONTENT =
  '# Edit in text editor\n\nfirst paragraph\n\nsecond paragraph target\n\nthird paragraph\n'
const TARGET_LINE = 4

test('Ctrl+Alt+E is inert; vmde.openTextEditor opens the source at the caret line', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(90_000)
  const docPath = path.join(baseDir, 'edit-in-text-editor.md')
  writeFileSync(docPath, CONTENT)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
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
  const editor = frame.locator('.vditor-ir').first()
  await editor.waitFor({ timeout: 60_000 })
  await frame.locator('body').evaluate(async () => {
    const ready = () => !!(window as any).vditor?.vditor?.lute
    for (let i = 0; i < 300 && !ready(); i++)
      await new Promise((r) => setTimeout(r, 100))
    if (!ready()) throw new Error('Lute never became available')
  })

  const activeTextEditor = () =>
    evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await new Promise((r) => setTimeout(r, 500))
      const active = vscode.window.activeTextEditor
      return active
        ? {
            path: active.document.uri.fsPath,
            line: active.selection.active.line,
          }
        : null
    }) as Promise<{ path: string; line: number } | null>

  await editor.click({ position: { x: 5, y: 5 } })
  await frame.locator('body').evaluate((_body) => {
    const root = document.querySelector<HTMLElement>(
      '.vditor-ir .vditor-reset',
    )!
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = (node.textContent ?? '').indexOf('target')
      if (index < 0) continue
      root.focus({ preventScroll: true })
      const range = document.createRange()
      range.setStart(node, index + 2)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      ;(window as any).__vmdeRequestCaret?.({ node, offset: index + 2 })
      document.dispatchEvent(new Event('selectionchange'))
      return
    }
    throw new Error('target paragraph not found')
  })

  // The former key, typed at the top level so it crosses the iframe boundary: nothing opens.
  await workbox.keyboard.press('Control+Alt+KeyE')
  expect(
    await activeTextEditor(),
    'Ctrl+Alt+E must not open the text editor',
  ).toBeNull()

  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('vmde.openTextEditor')
  })
  await expect
    .poll(activeTextEditor, { timeout: 15_000 })
    .toEqual({ path: docPath, line: TARGET_LINE })

  const docText = await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.workspace.textDocuments
        .find((d) => d.uri.fsPath === args[0])
        ?.getText() ?? '',
    [docPath] as [string],
  )
  expect(docText, 'neither route may edit the document').toBe(CONTENT)
})
