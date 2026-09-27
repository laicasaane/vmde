import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createSpecKeyboard } from './helpers/spec-keyboard'
import {
  docText,
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const BODY = 'Toolbar body **exact**.\n\n- toolbar item'
const CONTENT = [
  '# Toolbar details',
  '',
  '<details>',
  '<summary>Outer</summary>',
  '',
  'Outer first.',
  '',
  'Outer second.',
  '',
  '</details>',
  '',
  BODY,
  '',
  'Tail.',
  '',
].join('\n')
const WRAPPED = CONTENT.replace(
  BODY,
  `<details>\n<summary>Details</summary>\n\n${BODY}\n\n</details>`,
)
const NESTED = CONTENT.replace(
  'Outer second.',
  '<details>\n<summary>Details</summary>\n\nOuter second.\n\n</details>',
)

test('real pinned details toolbar wraps, survives modes, undoes, and unwraps exactly', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'details-toolbar.md')
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
    { message: 'details toolbar readiness' },
  )
  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const paragraph = Array.from(root.querySelectorAll<HTMLElement>('p')).find(
      (candidate) => candidate.textContent?.includes('Toolbar body'),
    )!
    const item = Array.from(root.querySelectorAll<HTMLElement>('li')).find(
      (candidate) => candidate.textContent?.includes('toolbar item'),
    )!
    const text = (element: HTMLElement, last: boolean) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (!node.parentElement?.closest('[data-render]'))
          nodes.push(node as Text)
      return last ? nodes.at(-1)! : nodes[0]
    }
    const start = text(paragraph, false)
    const end = text(item, true)
    const range = document.createRange()
    range.setStart(start, 0)
    range.setEnd(end, end.length)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    root.focus({ preventScroll: true })
    document.dispatchEvent(new Event('selectionchange'))
  })
  const toolbar = frame.locator('.vditor-toolbar [data-type="details"]')
  await expect(toolbar).toBeEnabled()
  await toolbar.click()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(WRAPPED)
  await expect(
    frame
      .locator('.vditor-ir .vmde-details__toggle')
      .filter({ hasText: 'Details' }),
  ).toHaveCount(1)
  await expect(toolbar).toHaveAttribute('aria-pressed', 'true')
  const input = await createSpecKeyboard(electronApp, workbox)
  await input.key('ctrl+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(CONTENT)
  await input.key('ctrl+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(WRAPPED)
  await expect(toolbar).toHaveAttribute('aria-pressed', 'true')

  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="wysiwyg"]').click()
  await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg')
  await expect(
    frame
      .locator('.vditor-wysiwyg .vmde-details__toggle')
      .filter({ hasText: 'Details' }),
  ).toHaveCount(1)
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  const native = frame
    .locator('.vditor-preview details')
    .filter({ hasText: 'Details' })
  await expect(native).toHaveCount(1)
  await native.locator('summary').click()
  await expect(native).toHaveAttribute('open', '')
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="sv"]').click()
  await waitForE2EReadiness(frame, (state) => state.mode === 'sv')
  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.sv.element as HTMLElement
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    const source = root.textContent ?? ''
    const start = source.indexOf('Toolbar body **exact**.')
    const end = source.indexOf('- toolbar item') + '- toolbar item'.length
    const point = (target: number): [Text, number] => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let offset = 0
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text
        if (target <= offset + text.length) return [text, target - offset]
        offset += text.length
      }
      throw new Error(`source offset ${target} missing`)
    }
    const range = document.createRange()
    range.setStart(...point(start))
    range.setEnd(...point(end))
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    root.focus({ preventScroll: true })
    document.dispatchEvent(new Event('selectionchange'))
  })
  await expect(toolbar).toHaveAttribute('aria-pressed', 'true')
  await toolbar.click()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(CONTENT)

  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.sv.element as HTMLElement
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    const source = root.textContent ?? ''
    const start = source.indexOf('Outer second.')
    const end = start + 'Outer second.'.length
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let offset = 0
    let startPoint: [Text, number] | null = null
    let endPoint: [Text, number] | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text
      if (!startPoint && start <= offset + text.length)
        startPoint = [text, start - offset]
      if (end <= offset + text.length) {
        endPoint = [text, end - offset]
        break
      }
      offset += text.length
    }
    const range = document.createRange()
    range.setStart(...startPoint!)
    range.setEnd(...endPoint!)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    root.focus({ preventScroll: true })
    document.dispatchEvent(new Event('selectionchange'))
  })
  await expect(toolbar).toBeEnabled()
  await expect(toolbar).toHaveAttribute('aria-pressed', 'false')
  await toolbar.click()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(NESTED)

  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(NESTED)
})
