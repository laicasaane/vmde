import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

type Mode = 'ir' | 'wysiwyg' | 'sv'

async function switchMode(
  frame: ReturnType<typeof wf>,
  mode: Mode,
): Promise<void> {
  await frame.locator('body').evaluate((_body, nextMode) => {
    const inner = (window as any).vditor.vditor
    if (inner.currentMode === nextMode) return
    inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    document
      .querySelector(`button[data-mode="${nextMode}"]`)
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
  }, mode)
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => (window as any).vditor.vditor.currentMode),
    )
    .toBe(mode)
}

async function placeCaret(
  frame: ReturnType<typeof wf>,
  mode: Mode,
): Promise<void> {
  await frame
    .locator(`.vditor-${mode}`)
    .first()
    .click({ position: { x: 8, y: 8 } })
  await frame.locator('body').evaluate((_body, currentMode) => {
    const root = (window as any).vditor.vditor[currentMode]
      .element as HTMLElement
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let text = walker.nextNode() as Text | null
    while (text && !text.data.includes('before '))
      text = walker.nextNode() as Text | null
    if (!text) throw new Error(`No anchor source prose in ${currentMode}`)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.setBaseAndExtent(text, 'before '.length, text, 'before '.length)
    ;(window as any).vditor.vditor[currentMode].range = selection
      .getRangeAt(0)
      .cloneRange()
  }, mode)
}

async function insertThroughMore(
  frame: ReturnType<typeof wf>,
  name: string,
): Promise<void> {
  await frame.locator('.vditor-toolbar [data-type="more"]').click()
  await frame.locator('[data-type="insert-anchor"]').click()
  const dialog = frame.locator('[data-vmde-anchor-dialog]')
  await dialog.locator('input').fill(name)
  await dialog.locator('button[type="submit"]').click()
}

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`More Insert anchor preserves source, history, save, and reopen in ${mode}`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(90_000)
    const docPath = path.join(baseDir, `named-anchor-mode-${mode}.md`)
    const initial = 'before selected prose after\r\n'
    const name = `mode-${mode}`
    const inserted = `before <a name="${name}"></a>selected prose after\r\n`
    writeFileSync(docPath, initial)
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
    let frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
    await waitForE2EReadiness(
      frame,
      (state) =>
        state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
      { message: `${mode} named-anchor fixture readiness` },
    )
    await switchMode(frame, mode)
    await placeCaret(frame, mode)
    await insertThroughMore(frame, name)
    await expect.poll(() => docText(evaluateInVSCode, docPath)).toBe(inserted)
    await frame.locator('body').evaluate(() => {
      const outer = (window as any).vditor
      outer.vditor.undo.undo(outer.vditor)
    })
    await expect.poll(() => docText(evaluateInVSCode, docPath)).toBe(initial)
    await frame.locator('body').evaluate(() => {
      const outer = (window as any).vditor
      outer.vditor.undo.redo(outer.vditor)
    })
    await expect.poll(() => docText(evaluateInVSCode, docPath)).toBe(inserted)
    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    })
    await expect.poll(() => readFileSync(docPath, 'utf8')).toBe(inserted)
    frame = await reopenVmdeFixture(
      evaluateInVSCode,
      workbox,
      docPath,
      60_000,
      '.vditor-ir, .vditor-wysiwyg, .vditor-sv',
      false,
    )
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.editorEpoch > 0 && !!state.mode,
      { message: `${mode} named-anchor reopen readiness` },
    )
    const restoredMode = await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.vditor.currentMode as string)
    if (mode === 'sv') {
      await expect.poll(() => docText(evaluateInVSCode, docPath)).toBe(inserted)
      await expect
        .poll(() =>
          frame
            .locator(`.vditor-${restoredMode}`)
            .evaluate((editor) => editor.isConnected),
        )
        .toBe(true)
    } else {
      await expect
        .poll(() =>
          frame
            .locator('body')
            .evaluate(() => (window as any).vditor.getValue() as string),
        )
        .toBe(inserted.replace('\r\n', '\n'))
    }
  })
}

test('SV Insert anchor posts exact CRLF source without a trailing paragraph', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  const docPath = path.join(baseDir, 'named-anchor-sv-exact.md')
  const initial = 'before selected prose after\r\n'
  const inserted = 'before <a name="sv-exact"></a>selected prose after\r\n'
  writeFileSync(docPath, initial)
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
    { message: 'SV exact named-anchor fixture readiness' },
  )
  await switchMode(frame, 'sv')
  await placeCaret(frame, 'sv')
  await insertThroughMore(frame, 'sv-exact')
  await expect
    .poll(() => docText(evaluateInVSCode, docPath), { timeout: 3_000 })
    .toBe(inserted)
})
