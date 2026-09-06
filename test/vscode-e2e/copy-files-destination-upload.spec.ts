import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('image upload honors markdown.copyFiles.destination and saves its exact link', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  const docs = path.join(baseDir, 'docs')
  const docPath = path.join(docs, 'guide.md')
  const targetFolder = path.join(docs, 'images', 'guide')
  mkdirSync(docs, { recursive: true })
  writeFileSync(docPath, '# Native destination\n\nCaret here.\n')

  const previous = (await evaluateInVSCode(
    async (vscode) => {
      const markdown = vscode.workspace.getConfiguration('markdown')
      const vmde = vscode.workspace.getConfiguration('vmde')
      const prior = {
        destination: markdown.inspect<Record<string, string>>(
          'copyFiles.destination',
        )?.globalValue,
        saveFolder: vmde.inspect<string>('image.saveFolder')?.globalValue,
      }
      await markdown.update(
        'copyFiles.destination',
        { '**/docs/**/*': 'images/${documentBaseName}/' },
        vscode.ConfigurationTarget.Global,
      )
      await vmde.update(
        'image.saveFolder',
        'assets',
        vscode.ConfigurationTarget.Global,
      )
      return JSON.stringify({
        destination: prior.destination ?? null,
        saveFolder: prior.saveFolder ?? null,
      })
    },
    [] as [],
  )) as string

  try {
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
      { message: 'copy-files destination fixture readiness' },
    )

    await frame.locator('body').evaluate((_body, pngBase64) => {
      const outer = (window as any).vditor
      const editor = outer.vditor[outer.getCurrentMode()].element as HTMLElement
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      let caretNode: Text | null = null
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node.textContent ?? '').includes('Caret here.')) continue
        caretNode = node as Text
        break
      }
      if (!caretNode) throw new Error('copy-files destination caret not found')
      const range = document.createRange()
      range.setStart(caretNode, caretNode.length)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus({ preventScroll: true })

      const bytes = Uint8Array.from(atob(pngBase64), (char) =>
        char.charCodeAt(0),
      )
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'shot.png', { type: 'image/png' }))
      editor.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      )
    }, PNG_B64)

    await expect
      .poll(
        () =>
          existsSync(targetFolder)
            ? readdirSync(targetFolder).filter((name) =>
                /_shot\.(png|webp)$/.test(name),
              )
            : [],
        { timeout: 15_000, intervals: [200, 400, 800] },
      )
      .toHaveLength(1)
    const writtenName = readdirSync(targetFolder).find((name) =>
      /_shot\.(png|webp)$/.test(name),
    )!
    const href = `images/guide/${writtenName}`
    const markup = `![](${href})`
    await expect
      .poll(() => docText(evaluateInVSCode, docPath), {
        timeout: 15_000,
        intervals: [200, 400, 800],
      })
      .toContain(markup)

    await evaluateInVSCode(
      async (vscode) => {
        await vscode.commands.executeCommand('workbench.action.files.save')
      },
      [] as [],
    )
    await expect.poll(() => readFileSync(docPath, 'utf8')).toContain(markup)
    expect(readFileSync(docPath, 'utf8')).toContain('# Native destination')
  } finally {
    await evaluateInVSCode(
      async (vscode, args: [string]) => {
        const prior = JSON.parse(args[0]) as {
          destination: Record<string, string> | null
          saveFolder: string | null
        }
        await vscode.workspace
          .getConfiguration('markdown')
          .update(
            'copyFiles.destination',
            prior.destination ?? undefined,
            vscode.ConfigurationTarget.Global,
          )
        await vscode.workspace
          .getConfiguration('vmde')
          .update(
            'image.saveFolder',
            prior.saveFolder ?? undefined,
            vscode.ConfigurationTarget.Global,
          )
      },
      [previous] as [string],
    )
  }
})
