import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, settle, wf } from './webview-helpers'

const source = [
  'Before.',
  '',
  '```math',
  'x^2',
  '```',
  '',
  'Block action target.',
  '',
].join('\r\n')

async function selectText(frame: ReturnType<typeof wf>, needle: string) {
  await frame.locator('.vditor-ir').click({ position: { x: 8, y: 8 } })
  await frame.locator('body').evaluate((_body, text) => {
    const root = document.querySelector('.vditor-ir')
    const walker = document.createTreeWalker(root!, NodeFilter.SHOW_TEXT)
    for (let next = walker.nextNode(); next; next = walker.nextNode()) {
      const node = next as Text
      const offset = node.data.indexOf(text)
      if (offset < 0) continue
      const selection = getSelection()!
      selection.setBaseAndExtent(node, offset, node, offset + text.length)
      ;(node.parentElement as HTMLElement | null)?.focus()
      return
    }
    throw new Error(`missing ${text}`)
  }, needle)
}

test('GitHub fenced Math displays, inserts, undoes, and saves exact CRLF source', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(90_000)
  const file = path.join(baseDir, 'github-fenced-math.md')
  writeFileSync(file, source)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), [target]: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(target),
        'vmde.editor',
      )
    },
    [file],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('.language-math')].some(
            (node) =>
              node.tagName === 'CODE' &&
              node.parentElement?.tagName === 'PRE' &&
              node.querySelector('.katex-display') !== null,
          ),
        ),
    )
    .toBe(true)
  await selectText(frame, 'Block action target.')
  await frame.locator('[data-type="math"]').click()
  await frame.locator('[data-type="math-block"]').click()
  await expect
    .poll(() => docText(evaluateInVSCode, file), { timeout: 20_000 })
    .toContain('```math\r\nBlock action target.\r\n```')
  await frame.locator('[data-type="undo"]').click()
  await settle(frame, 100)
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(source)
})
