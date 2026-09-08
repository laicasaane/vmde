import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  settle,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

test('Format table command keeps exact CRLF source through undo, redo, save, and reopen in SV', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'table-format.md')
  const before = [
    'before',
    '',
    '|a| longer |',
    '|:-|---:|',
    '|x\\|y|全角|',
    '',
    'after',
    '',
  ].join('\r\n')
  const after = [
    'before',
    '',
    '| a   | longer |',
    '| :-- | -----: |',
    '| x\\|y |   全角 |',
    '',
    'after',
    '',
  ].join('\r\n')
  writeFileSync(file, before)
  await evaluateInVSCode(
    async (vscode, args: string[]) => {
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
  await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
  await settle(frame, 1500)
  await frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    document.querySelector<HTMLButtonElement>('button[data-mode="sv"]')?.click()
  })
  await waitForE2EReadiness(frame, (state) => state.mode === 'sv', {
    message: 'SV did not become ready',
  })
  await frame.locator('.vditor-sv').click()
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: serializes the real source-range setup and root-wide coordinate assertion into one webview task.
  const captureInitialSelection = () => {
    const root = (window as any).vditor.vditor.sv.element as HTMLElement
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let remaining = (root.textContent ?? '').indexOf('longer') + 2
    for (
      let node = walker.nextNode() as Text | null;
      node;
      node = walker.nextNode() as Text | null
    ) {
      if (remaining <= node.data.length) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        if (!(window as any).__vmdeCaptureTableFormatSelectionForTest?.())
          throw new Error(
            'SV table source selection was not captured before host focus',
          )
        const before = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let rootOffset = 0
        for (
          let text = before.nextNode() as Text | null;
          text;
          text = before.nextNode() as Text | null
        ) {
          if (text === selection.anchorNode) {
            rootOffset += selection.anchorOffset
            break
          }
          rootOffset += text.data.length
        }
        return {
          rootOffset,
          expected: (root.textContent ?? '').indexOf('longer') + 2,
        }
      }
      remaining -= node.data.length
    }
    throw new Error('SV table caret target missing')
  }
  const initialSelection = await frame
    .locator('body')
    .evaluate(captureInitialSelection)
  expect(initialSelection.rootOffset).toBe(initialSelection.expected)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.formatTable')
  })
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
  const restoredCaret = await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.sv.element as HTMLElement
    const selection = getSelection()
    if (!selection?.rangeCount || !selection.anchorNode)
      return { actual: -1, expected: -1 }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let actual = 0
    for (
      let text = walker.nextNode() as Text | null;
      text;
      text = walker.nextNode() as Text | null
    ) {
      if (text === selection.anchorNode) {
        actual += selection.anchorOffset
        break
      }
      actual += text.data.length
    }
    return {
      actual,
      expected: (root.textContent ?? '').indexOf('longer') + 2,
    }
  })
  expect(restoredCaret.actual).toBe(restoredCaret.expected)
  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.sv.element as HTMLElement
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(before)
  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.sv.element as HTMLElement
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'y',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === args[0],
      )
      if (!document || !(await document.save()))
        throw new Error('formatted source document did not save')
    },
    [file] as [string],
  )
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(after)
  frame = await reopenVmdeFixture(
    evaluateInVSCode,
    workbox,
    file,
    60_000,
    '.vditor-ir',
  )
  expect(await readFileSync(file, 'utf8')).toBe(after)
  expect(
    await frame.locator('body').evaluate(() => {
      const root = (window as any).vditor.vditor.ir.element as HTMLElement
      return root.textContent
    }),
  ).toContain('longer')
})
