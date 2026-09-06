import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness } from './webview-helpers'

const paragraphs = Array.from(
  { length: 80 },
  (_, index) => `source reveal paragraph ${index}`,
)
const CONTENT = `${paragraphs.join('\n\n')}\n`

function wf(workbox: import('@playwright/test').Page) {
  return workbox
    .frameLocator('iframe.webview:visible')
    .frameLocator('iframe[title="VMDE"], #active-frame')
}

type VmdeFrame = ReturnType<typeof wf>

const revealState = (frame: VmdeFrame, needle: string) =>
  frame.locator('body').evaluate((_body, targetText) => {
    const editor = (
      window as unknown as {
        vditor: { vditor: { ir: { element: HTMLElement } } }
      }
    ).vditor.vditor.ir.element
    const target = Array.from(editor.children).find((block) =>
      (block.textContent ?? '').includes(targetText as string),
    ) as HTMLElement | undefined
    const selection = getSelection()
    const anchor = selection?.rangeCount ? selection.anchorNode : null
    const editorRect = editor.getBoundingClientRect()
    const targetRect = target?.getBoundingClientRect()
    return {
      found: Boolean(target),
      flashed: target?.classList.contains('heading-flash') ?? false,
      caretInTarget: !!anchor && !!target?.contains(anchor),
      inViewport: Boolean(
        targetRect &&
          targetRect.top >= editorRect.top - 3 &&
          targetRect.top < editorRect.bottom,
      ),
    }
  }, needle)

async function expectRevealed(frame: VmdeFrame, needle: string) {
  await expect
    .poll(() => revealState(frame, needle), { timeout: 20_000 })
    .toEqual({
      found: true,
      flashed: true,
      caretInTarget: true,
      inViewport: true,
    })
}

test('source selection reveals the matching block on open and on an existing VMDE tab', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const docPath = path.join(baseDir, 'source-line-reveal.md')
  writeFileSync(docPath, CONTENT)
  const firstParagraph = 34
  const firstLine = firstParagraph * 2
  await evaluateInVSCode(
    async (vscode, args: [string, number]) => {
      const [file, line] = args
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      const uri = vscode.Uri.file(file)
      const selection = new vscode.Range(line, 0, line, 0)
      await vscode.commands.executeCommand('vscode.open', uri, {
        preview: false,
        selection,
      })
      // Probe Task 52's open-with-selection boundary directly. The provider records whether
      // activeTextEditor still exposes this same-document selection while custom resolution runs.
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        'vmde.editor',
        {
          selection,
        },
      )
    },
    [docPath, firstLine] as [string, number],
  )

  let frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'source-line initial reveal readiness' },
  )
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)))
  // Probe outcome: vscode.openWith drops the source TextEditor selection before the custom
  // provider resolves. Pin the negative boundary instead of pretending the init payload saw it.
  expect(await revealState(frame, paragraphs[firstParagraph])).toEqual({
    found: true,
    flashed: false,
    caretInTarget: false,
    inViewport: false,
  })

  const fallbackProbe = (await evaluateInVSCode(
    async (vscode, args: [string, number]) => {
      const [file, line] = args
      const uri = vscode.Uri.file(file)
      await vscode.commands.executeCommand('vscode.open', uri, {
        preview: false,
        selection: new vscode.Range(line, 0, line, 0),
      })
      const active = vscode.window.activeTextEditor
      const before = {
        uri: active?.document.uri.fsPath ?? '',
        line: active?.selection.active.line ?? -1,
        lineText:
          active?.document.lineAt(active.selection.active.line).text ?? '',
      }
      // Existing-panel path: captures activeTextEditor, focuses the retained VMDE tab, then posts
      // the live reveal-line message.
      await vscode.commands.executeCommand('vmde.openEditor')
      return before
    },
    [docPath, firstLine] as [string, number],
  )) as { uri: string; line: number; lineText: string }
  expect(fallbackProbe).toEqual({
    uri: docPath,
    line: firstLine,
    lineText: paragraphs[firstParagraph],
  })
  frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'source-line existing-panel reveal readiness' },
  )
  await expectRevealed(frame, paragraphs[firstParagraph])

  const secondParagraph = 57
  const secondLine = secondParagraph * 2
  const newPanelProbe = (await evaluateInVSCode(
    async (vscode, args: [string, number]) => {
      const [file, line] = args
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      const uri = vscode.Uri.file(file)
      for (let attempt = 0; attempt < 100; attempt++) {
        const customStillOpen = vscode.window.tabGroups.all.some((group) =>
          group.tabs.some(
            (tab) =>
              tab.input instanceof vscode.TabInputCustom &&
              tab.input.uri.fsPath === uri.fsPath &&
              tab.input.viewType === 'vmde.editor',
          ),
        )
        if (!customStillOpen) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const customTabsBeforeOpen = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter(
          (tab) =>
            tab.input instanceof vscode.TabInputCustom &&
            tab.input.uri.fsPath === uri.fsPath &&
            tab.input.viewType === 'vmde.editor',
        ).length
      await vscode.commands.executeCommand('vscode.open', uri, {
        preview: false,
        selection: new vscode.Range(line, 0, line, 0),
      })
      await vscode.commands.executeCommand('vmde.openEditor')
      return {
        customTabsBeforeOpen,
        activeLine: vscode.window.activeTextEditor?.selection.active.line ?? -1,
      }
    },
    [docPath, secondLine] as [string, number],
  )) as { customTabsBeforeOpen: number; activeLine: number }
  expect(newPanelProbe.customTabsBeforeOpen).toBe(0)
  frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  const newPanelDelivery = await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady &&
      state.editorEpoch > 0 &&
      (state.completed['reveal-line'] ?? 0) > 0,
    { timeout: 20_000, message: 'new-panel reveal-line delivery' },
  )
  expect(
    Object.keys(newPanelDelivery.completed).filter((key) =>
      key.startsWith('reveal-line:error:'),
    ),
  ).toEqual([])
  await expectRevealed(frame, paragraphs[secondParagraph])
})
