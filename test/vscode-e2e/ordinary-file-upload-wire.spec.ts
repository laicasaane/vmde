import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

const INITIAL = '# Ordinary upload target\n\nCaret here.\n'
const FILE_BYTES = 'plain file body\nsecond line\n'

test('dropping an ordinary file writes its bytes and saves a normal Markdown link', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  const docPath = path.join(baseDir, 'ordinary-file-drop.md')
  const assetsPath = path.join(baseDir, 'assets')
  writeFileSync(docPath, INITIAL)

  await evaluateInVSCode(
    async (vscode, args: [string]) => {
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
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'ordinary-file drop fixture readiness' },
  )

  await frame.locator('body').evaluate((_body, fileBytes) => {
    const instance = (window as any).vditor
    const editor = instance.vditor[instance.getCurrentMode()]
      .element as HTMLElement
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let caretNode: Text | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node.textContent ?? '').includes('Caret here.')) continue
      caretNode = node as Text
      break
    }
    if (!caretNode) throw new Error('ordinary-file drop caret anchor not found')

    const range = document.createRange()
    range.setStart(caretNode, caretNode.length)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus({ preventScroll: true })

    const transfer = new DataTransfer()
    transfer.items.add(
      new File([fileBytes], 'notes.txt', { type: 'text/plain' }),
    )
    editor.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
      }),
    )
  }, FILE_BYTES)

  await expect
    .poll(
      () =>
        existsSync(assetsPath)
          ? readdirSync(assetsPath).filter((name) =>
              name.endsWith('_notes.txt'),
            )
          : [],
      { timeout: 15_000, intervals: [200, 400, 800] },
    )
    .toHaveLength(1)

  const writtenName = readdirSync(assetsPath).find((name) =>
    name.endsWith('_notes.txt'),
  )!
  expect(writtenName).toMatch(/^\d{8}_\d{6}_notes\.txt$/)
  expect(readFileSync(path.join(assetsPath, writtenName), 'utf8')).toBe(
    FILE_BYTES,
  )

  const href = `assets/${writtenName}`
  const link = `[${writtenName}](${href})`
  await expect
    .poll(() => docText(evaluateInVSCode, docPath), {
      timeout: 15_000,
      intervals: [200, 400, 800],
    })
    .toContain(link)
  const liveText = await docText(evaluateInVSCode, docPath)
  expect(liveText).not.toContain(`![](${href})`)
  expect(liveText).toContain('# Ordinary upload target')
  expect(liveText).toContain('Caret here.')

  await evaluateInVSCode(
    async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    },
    [] as [],
  )
  await expect
    .poll(
      () =>
        evaluateInVSCode(
          async (vscode, args: [string]) =>
            vscode.workspace.textDocuments.find(
              (document) => document.uri.fsPath === args[0],
            )?.isDirty ?? true,
          [docPath] as [string],
        ),
      { timeout: 15_000, intervals: [200, 400, 800] },
    )
    .toBe(false)

  const saved = readFileSync(docPath, 'utf8')
  expect(saved).toContain(link)
  expect(saved).not.toContain(`![](${href})`)
  expect(saved).toContain('# Ordinary upload target')
  expect(saved).toContain('Caret here.')
})
