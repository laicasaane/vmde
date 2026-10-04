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

const INITIAL = `# Root

intro

## Child

body

### Grandchild

## Sibling

# Next

Setext
------
`

const SECTION_SHIFTED = INITIAL.replace('# Root', '## Root')
  .replace('## Child', '### Child')
  .replace('### Grandchild', '#### Grandchild')
  .replace('## Sibling', '### Sibling')

// Task 580 CP2-4 — Ctrl+Shift+[ / ] now belong to Fold / Unfold and the webview no longer matches
// the heading-shift chords. CP2-7 — every shift runs through its unbound command:
// `vmde.promoteHeading` / `vmde.demoteHeading` and the section variants.
test('heading shift commands shift one heading or its subtree with exact undo and save; the old chords are inert', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'heading-level-shift.md')
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

  const frame = wf(workbox)
  const currentValue = () =>
    frame
      .locator('body')
      .evaluate(() => (window as any).vditor.getValue() as string)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'heading level shift readiness' },
  )
  await frame.locator('.vditor-ir').click({ position: { x: 20, y: 20 } })

  const place = (needle: string, offset: number) =>
    frame.locator('body').evaluate(
      (_body, args) => {
        const inner = (window as any).vditor.vditor
        const editor = inner.ir.element as HTMLElement
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = (node.textContent ?? '').indexOf(args.needle)
          if (index < 0) continue
          editor.focus({ preventScroll: true })
          const range = document.createRange()
          range.setStart(node, index + args.offset)
          range.collapse(true)
          const selection = getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
          return
        }
        throw new Error(`${args.needle} not found`)
      },
      { needle, offset },
    )

  const run = (command: string) =>
    evaluateInVSCode(async (vscode, id: string) => {
      await vscode.commands.executeCommand(id)
    }, command)
  const demoteHeading = () => run('vmde.demoteHeading')

  await place('Child', 2)
  const foldedCount = () =>
    frame
      .locator('body')
      .evaluate(() => document.querySelectorAll('[data-vmde-folded]').length)
  for (const chord of ['Control+Alt+Shift+]', 'Control+Alt+Shift+['])
    await workbox.keyboard.press(chord)
  // Fold then Unfold: the chords that used to shift the heading now fold and unfold its section.
  await workbox.keyboard.press('Control+Shift+[')
  await expect.poll(foldedCount).toBe(1)
  await workbox.keyboard.press('Control+Shift+]')
  await expect.poll(foldedCount).toBe(0)
  await workbox.waitForTimeout(500)
  expect(await docText(evaluateInVSCode, file)).toBe(INITIAL)
  expect(await currentValue()).toBe(INITIAL)
  // Vditor's own keydown handling may split the caret's text node, so the caret stays where it was
  // placed instead of being searched for again.
  await demoteHeading()
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(INITIAL.replace('## Child', '### Child'))
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INITIAL)
  await expect.poll(currentValue).toBe(INITIAL)

  // Undo restores the heading with its text split at the earlier caret ("Ch" | "ild"), so search
  // for the first half; the caret lands at the same offset.
  await place('Ch', 2)
  await run('vmde.promoteHeading')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(INITIAL.replace('## Child', '# Child'))
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INITIAL)
  await expect.poll(currentValue).toBe(INITIAL)

  // The section variants shift the heading and its subtree; one Undo recovers each.
  await place('Root', 1)
  await run('vmde.demoteHeadingSection')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(SECTION_SHIFTED)
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INITIAL)
  await expect.poll(currentValue).toBe(INITIAL)

  await place('Ch', 2)
  await run('vmde.promoteHeadingSection')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(
      INITIAL.replace('## Child', '# Child').replace(
        '### Grandchild',
        '## Grandchild',
      ),
    )
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INITIAL)
  await expect.poll(currentValue).toBe(INITIAL)

  await frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    const editor = inner.ir.element as HTMLElement
    const headings = Array.from(
      editor.querySelectorAll<HTMLElement>('h1,h2,h3'),
    )
    const text = (needle: string) => {
      const heading = headings.find((candidate) =>
        candidate.textContent?.includes(needle),
      )!
      const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (
          node.textContent?.trim() &&
          !node.parentElement?.closest('.vditor-ir__marker')
        )
          return node as Text
      }
      throw new Error(`${needle} text not found`)
    }
    const root = text('Root')
    const sibling = text('Sibling')
    editor.focus({ preventScroll: true })
    const range = document.createRange()
    range.setStart(root, 0)
    range.setEnd(sibling, sibling.data.length)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await demoteHeading()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(SECTION_SHIFTED)

  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(SECTION_SHIFTED)
})
