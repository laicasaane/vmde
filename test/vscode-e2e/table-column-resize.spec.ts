import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

const INITIAL = [
  'before',
  '',
  '|  Long heading  | Other |',
  '| :--- | ---: |',
  '| *one* | `two` |',
  '',
  'after',
  '',
].join('\r\n')

async function dragFirstHandle(
  frame: ReturnType<typeof wf>,
  mode: 'ir' | 'wysiwyg',
) {
  const header = frame.locator(`.vditor-${mode} table th`).first()
  const handle = frame.locator('.vmde-table-resize-handle').first()
  await expect(handle).toBeVisible()
  const position = await frame.locator('body').evaluate(() => {
    const mode = (window as any).vditor.getCurrentMode()
    const head = (window as any).vditor.vditor[mode].element.querySelector(
      'table th',
    ) as HTMLElement
    const grip = document.querySelector(
      '.vmde-table-resize-handle',
    ) as HTMLElement
    return {
      right: head.getBoundingClientRect().right,
      handle:
        grip.getBoundingClientRect().left +
        grip.getBoundingClientRect().width / 2,
    }
  })
  expect(Math.abs(position.right - position.handle)).toBeLessThan(3)
  const before = (await header.boundingBox())!.width
  await handle.evaluate((grip) => {
    const rect = grip.getBoundingClientRect()
    const startX = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    grip.dispatchEvent(
      new MouseEvent('mousedown', {
        button: 0,
        clientX: startX,
        clientY: y,
        bubbles: true,
        cancelable: true,
      }),
    )
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: startX + 120,
        clientY: y,
        bubbles: true,
      }),
    )
    document.dispatchEvent(
      new MouseEvent('mouseup', {
        clientX: startX + 120,
        clientY: y,
        bubbles: true,
      }),
    )
  })
  await expect
    .poll(async () => (await header.boundingBox())!.width)
    .toBeGreaterThan(before + 40)
  await expect(frame.locator(`.vditor-${mode} table`)).toHaveClass(
    /vmde-table-resized/,
  )
}

test('session table widths are source-invisible in both modes and reset on reopen', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'table-column-resize.md')
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
  let frame = wf(workbox)
  await frame
    .locator('.vditor-ir table th')
    .first()
    .waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(frame, (state) => state.mode === 'ir', {
    timeout: 60_000,
    message: 'IR table did not become ready',
  })
  await dragFirstHandle(frame, 'ir')
  expect(readFileSync(file, 'utf8')).toBe(INITIAL)
  expect(
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) =>
        vscode.workspace.textDocuments
          .find((document) => document.uri.fsPath === args[0])
          ?.getText(),
      [file] as [string],
    ),
  ).toBe(INITIAL)

  await frame.locator('body').evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
    timeout: 60_000,
    message: 'WYSIWYG table did not become ready',
  })
  await dragFirstHandle(frame, 'wysiwyg')
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(INITIAL)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  frame = wf(workbox)
  await waitForE2EReadiness(frame, (state) => state.routerReady, {
    timeout: 60_000,
    message: 'reopened table did not become ready',
  })
  const reopened = await frame.locator('body').evaluate(() => {
    const editor = (window as any).vditor
    const mode = editor.getCurrentMode()
    const table = editor.vditor[mode].element.querySelector(
      'table',
    ) as HTMLTableElement | null
    return {
      mode,
      table: Boolean(table),
      resized: table?.classList.contains('vmde-table-resized'),
    }
  })
  expect(['ir', 'wysiwyg']).toContain(reopened.mode)
  expect(reopened.table).toBe(true)
  expect(reopened.resized).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe(INITIAL)

  const otherMode = reopened.mode === 'ir' ? 'wysiwyg' : 'ir'
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator(`button[data-mode="${otherMode}"]`).click()
  await waitForE2EReadiness(frame, (state) => state.mode === otherMode, {
    timeout: 60_000,
    message: `reopened ${otherMode} table did not become ready`,
  })
  const otherModeTable = await frame.locator('body').evaluate(() => {
    const editor = (window as any).vditor
    const mode = editor.getCurrentMode()
    const table = editor.vditor[mode].element.querySelector(
      'table',
    ) as HTMLTableElement | null
    return {
      mode,
      table: Boolean(table),
      resized: table?.classList.contains('vmde-table-resized'),
    }
  })
  expect(otherModeTable.mode).toBe(otherMode)
  expect(otherModeTable.table).toBe(true)
  expect(otherModeTable.resized).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe(INITIAL)
})
