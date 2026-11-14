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

const CONTENT = [
  '# Details',
  '',
  '<details>',
  '<summary>More info</summary>',
  '',
  'Body **bold**.',
  '',
  '| Key | Value |',
  '| --- | --- |',
  '| one | two |',
  '',
  '</details>',
  '',
  '<details open>',
  '<summary>Open initially</summary>',
  '',
  'Visible body.',
  '',
  '</details>',
  '',
  'Tail paragraph.',
  '',
].join('\n')

test('details toggle in real edit modes and native Preview without changing source', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'details-editing.md')
  writeFileSync(file, CONTENT)
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

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'details edit-mode readiness' },
  )

  const irButtons = frame.locator('.vditor-ir .vmde-details__toggle')
  await expect(irButtons).toHaveCount(2)
  await expect(irButtons.first()).toHaveAttribute('aria-expanded', 'false')
  await expect(irButtons.nth(1)).toHaveAttribute('aria-expanded', 'true')
  const irBody = frame
    .locator('.vditor-ir p')
    .filter({ hasText: 'Body' })
    .first()
  const irTable = frame.locator('.vditor-ir table').first()
  await expect(irBody).toBeHidden()
  await expect
    .poll(() =>
      irTable.evaluate((element) =>
        element.style.getPropertyValue('table-layout'),
      ),
    )
    .toBe('fixed')
  await expect(irTable).toBeHidden()
  await irButtons.first().click()
  await expect(irBody).toBeVisible()
  await expect(irTable).toBeVisible()
  await expect(irTable).toHaveCSS('display', 'table')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(CONTENT)

  await frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    const root = inner.ir.element as HTMLElement
    const paragraph = Array.from(root.querySelectorAll<HTMLElement>('p')).find(
      (candidate) => candidate.textContent?.includes('Body'),
    )!
    const text = paragraph.firstChild!
    root.focus({ preventScroll: true })
    const range = document.createRange()
    range.setStart(text, 2)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await expect(
    frame.locator('.vditor-ir [data-vmde-details-editing]'),
  ).toHaveCount(2)
  await expect(irButtons.first()).toBeHidden()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(CONTENT)

  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="wysiwyg"]').click()
  await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
    message: 'details WYSIWYG readiness',
  })
  const wysButtons = frame.locator('.vditor-wysiwyg .vmde-details__toggle')
  await expect(wysButtons).toHaveCount(2)
  const wysTable = frame.locator('.vditor-wysiwyg table').first()
  await expect
    .poll(() =>
      wysTable.evaluate((element) =>
        element.style.getPropertyValue('table-layout'),
      ),
    )
    .toBe('fixed')
  await expect(wysTable).toBeHidden()
  await wysButtons.first().click()
  await expect(wysButtons.first()).toHaveAttribute('aria-expanded', 'true')
  await expect(wysTable).toBeVisible()
  await expect(wysTable).toHaveCSS('display', 'table')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(CONTENT)

  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  const native = frame.locator('.vditor-preview details').first()
  await expect(native).toBeVisible()
  await expect(native).not.toHaveAttribute('open', /.*/)
  await native.locator('summary').click()
  await expect(native).toHaveAttribute('open', '')

  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(CONTENT)

  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  await frame.locator('.vditor-wysiwyg:visible').waitFor()
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="sv"]').click()
  await waitForE2EReadiness(frame, (state) => state.mode === 'sv', {
    message: 'details snippet Source-mode readiness',
  })
  const undoLength = () =>
    frame.locator('body').evaluate(() => {
      const inner = (window as any).vditor.vditor
      return (
        (globalThis as any).__vmdeUnitHistory?.holds(inner)
          ? (globalThis as any).__vmdeUnitHistory.depth(inner).undo
          : inner.undo[inner.currentMode].undoStack.length
      ) as number
    })
  const beforeSnippetUndo = await undoLength()
  await frame.locator('.vditor-sv').click({ position: { x: 10, y: 10 } })
  await frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    const root = inner.sv.element as HTMLElement
    root.focus({ preventScroll: true })
    const range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    ;(window as any).__vmdeRequestCaret?.({
      node: range.startContainer,
      offset: range.startOffset,
    })
  })
  await workbox.keyboard.type(';;det')
  const hint = frame
    .locator('.vditor-hint:visible button')
    .filter({ hasText: 'Details' })
  await expect(hint).toHaveCount(1)
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toContain(`${CONTENT};;det`)
  await expect
    .poll(undoLength)
    .toBeGreaterThanOrEqual(Math.max(2, beforeSnippetUndo + 1))
  const triggerUndoLength = await undoLength()
  await hint.click()
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toContain('<summary>Details</summary>')
  await expect.poll(undoLength).toBeGreaterThanOrEqual(triggerUndoLength + 1)
  await workbox.keyboard.press('Control+z')
  await expect
    .poll(async () => {
      const text = await docText(evaluateInVSCode, file)
      return {
        hasTemplate: text.includes('<summary>Details</summary>'),
        hasTrigger: text.includes(';;det'),
      }
    })
    .toEqual({ hasTemplate: false, hasTrigger: true })
})
