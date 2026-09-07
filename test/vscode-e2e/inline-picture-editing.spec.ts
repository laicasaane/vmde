import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const INITIAL =
  'Before <picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"><img src="light.png" alt="Existing"></picture> after\r\n'
const INSERTED =
  'Before <picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"><img src="light.png" alt="New &amp; &quot;alt&quot;"></picture><picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"><img src="light.png" alt="Existing"></picture> after\r\n'

test('More Insert picture renders safe relative sources and saves one source-faithful undo transaction', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'inline-picture-editing.md')
  writeFileSync(file, INITIAL)
  await evaluateInVSCode(
    async (vscode, args: [string, string, string]) => {
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [file, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )
  let frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { message: 'inline PICTURE IR readiness' },
  )
  const preview = frame.locator('[data-vmde-inline-picture="1"]')
  await expect(preview).toHaveCount(1)
  expect(
    await preview.evaluate((picture) => ({
      source: picture.querySelector('source')?.getAttribute('srcset'),
      fallback: picture.querySelector('img')?.getAttribute('src'),
      alt: picture.querySelector('img')?.getAttribute('alt'),
      render: picture.getAttribute('data-render'),
    })),
  ).toEqual({
    source: 'dark.png',
    fallback: 'light.png',
    alt: 'Existing',
    render: '1',
  })
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => (window as any).vditor.getValue()),
    )
    .toBe(INITIAL.replace('\r\n', '\n'))
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INITIAL)

  await frame.locator('body').evaluate(() => {
    const paragraph = Array.from(
      document.querySelectorAll('.vditor-ir p'),
    ).find((element) => element.textContent?.startsWith('Before '))!
    const text = paragraph.firstChild!
    const range = document.createRange()
    range.setStart(text, 'Before '.length)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    ;(window as any).vditor.vditor.ir.range = range.cloneRange()
  })
  await frame.locator('.vditor-toolbar [data-type="more"]').click()
  await frame.locator('[data-type="insert-picture"]').click()
  const dialog = frame.locator('[data-vmde-picture-dialog]')
  await dialog.locator('input[name="fallback"]').fill('light.png')
  await dialog.locator('input[name="alt"]').fill('New & "alt"')
  await dialog.locator('input[name="dark"]').fill('dark.png')
  await dialog.locator('button[type="submit"]').click()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INSERTED)

  await frame.locator('body').evaluate(() => {
    const outer = (window as any).vditor
    outer.vditor.undo.undo(outer.vditor)
  })
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INITIAL)

  await frame.locator('body').evaluate(() => {
    const outer = (window as any).vditor
    outer.vditor.undo.redo(outer.vditor)
  })
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INSERTED)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(INSERTED)

  await evaluateInVSCode(
    async (vscode, args: [string, string, string]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [file, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )
  frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { message: 'inline PICTURE reopen readiness' },
  )
  await expect(frame.locator('[data-vmde-inline-picture="1"]')).toHaveCount(2)
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INSERTED)

  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="wysiwyg"]').click()
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'wysiwyg',
    { message: 'inline PICTURE WYSIWYG readiness' },
  )
  await expect(
    frame.locator('.vditor-wysiwyg [data-vmde-inline-picture="1"]'),
  ).toHaveCount(2)
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  await expect(frame.locator('.vditor-preview picture')).toHaveCount(2)
})
