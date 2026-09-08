import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const ORIGINAL = ['# A', '', 'A body.', '', '# B', '', 'B body.', ''].join('\n')
const MOVED = ['# B', '', 'B body.', '', '# A', '', 'A body.', ''].join('\n')

test('outline drag and Explorer controller move exact sections once and reject stale native drops', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'outline-reorder.md')
  writeFileSync(file, ORIGINAL)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
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
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'outline reorder editor readiness' },
  )
  await frame.locator('body').evaluate(() => {
    ;(window as any).__outlineDragErrors = []
    window.addEventListener(
      'error',
      (event) => (window as any).__outlineDragErrors.push(event.message),
      { once: true },
    )
    const inner = (window as any).vditor.vditor
    inner.outline.toggle(inner, true)
  })
  const rows = frame.locator('.vditor-outline li > span[data-target-id]')
  await expect(rows).toHaveCount(2)
  await expect.poll(() => rows.first().getAttribute('draggable')).toBe('true')

  await frame.locator('body').evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.vditor-outline li > span[data-target-id]',
      ),
    )
    const source = rows.find((row) => row.textContent?.includes('B'))!
    const target = rows.find((row) => row.textContent?.includes('A'))!
    const data = new DataTransfer()
    source.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientY: rect.top + 1,
        dataTransfer: data,
      }),
    )
    ;(window as any).__outlineDragState = {
      marker: target.dataset.vmdeOutlineDrop,
      source: data.getData('application/x-vmde-outline'),
      mover: typeof (window as any).__vmdeRunOutlineSectionMoveByIndex,
    }
    target.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.top + 1,
        dataTransfer: data,
      }),
    )
  })
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as any).__outlineDragState),
  ).toEqual({ marker: 'before', source: '1', mover: 'function' })
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as any).__outlineDragErrors),
  ).toEqual([])
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(MOVED)

  await frame.locator('.vditor-ir').click()
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(ORIGINAL)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(MOVED)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), _args: [string]) => {
      const extension = vscode.extensions.getExtension('Laicasaane.vmde')
      const api = extension?.exports as any
      if (!api?.outlineProvider || !api?.outlineDragAndDrop) {
        throw new Error('Task 222 test seam is unavailable')
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
      const [b, a] = api.outlineProvider.getChildren()
      const data = new vscode.DataTransfer()
      await api.outlineDragAndDrop.handleDrag(
        [a],
        data,
        new vscode.CancellationTokenSource().token,
      )
      await api.outlineDragAndDrop.handleDrop(
        b,
        data,
        new vscode.CancellationTokenSource().token,
      )
    },
    [file] as [string],
  )
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(ORIGINAL)

  const staleBefore = await docText(evaluateInVSCode, file)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      const api = vscode.extensions.getExtension('Laicasaane.vmde')
        ?.exports as any
      await new Promise((resolve) => setTimeout(resolve, 250))
      const [source, target] = api.outlineProvider.getChildren()
      const data = new vscode.DataTransfer()
      await api.outlineDragAndDrop.handleDrag(
        [source],
        data,
        new vscode.CancellationTokenSource().token,
      )
      const document = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )!
      const edit = new vscode.WorkspaceEdit()
      edit.insert(document.uri, new vscode.Position(0, 0), '<!-- changed -->\n')
      await vscode.workspace.applyEdit(edit)
      await api.outlineDragAndDrop.handleDrop(
        target,
        data,
        new vscode.CancellationTokenSource().token,
      )
    },
    [file] as [string],
  )
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(`<!-- changed -->\n${staleBefore}`)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      const document = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )
      if (!document || !(await document.save())) throw new Error('save failed')
    },
    [file] as [string],
  )
  expect(readFileSync(file, 'utf8')).toBe(`<!-- changed -->\n${staleBefore}`)

  const reopened = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await expect(reopened.locator('.vditor-reset h1').first()).toHaveText('# A')
})
