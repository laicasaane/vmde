import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

async function switchMode(
  frame: ReturnType<typeof wf>,
  mode: 'ir' | 'wysiwyg' | 'sv',
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

async function placeAnchorCaret(
  frame: ReturnType<typeof wf>,
  mode: 'ir' | 'wysiwyg' | 'sv',
  prefix = 'before ',
): Promise<void> {
  await frame
    .locator(`.vditor-${mode}`)
    .first()
    .click({ position: { x: 8, y: 8 } })
  await frame.locator('body').evaluate(
    (_body, [currentMode, textPrefix]) => {
      const root = (window as any).vditor.vditor[currentMode]
        .element as HTMLElement
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let text = walker.nextNode() as Text | null
      while (text && !text.data.includes(textPrefix))
        text = walker.nextNode() as Text | null
      if (!text) throw new Error(`No source prose in ${currentMode} mode`)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.setBaseAndExtent(
        text,
        textPrefix.length,
        text,
        textPrefix.length,
      )
      ;(window as any).vditor.vditor[currentMode].range = selection
        .getRangeAt(0)
        .cloneRange()
    },
    [mode, prefix] as const,
  )
}

async function insertAnchorThroughMore(
  frame: ReturnType<typeof wf>,
  name: string,
): Promise<void> {
  await frame.locator('.vditor-toolbar [data-type="more"]').click()
  await frame.locator('[data-type="insert-anchor"]').click()
  const dialog = frame.locator('[data-vmde-anchor-dialog]')
  await dialog.locator('input').fill(name)
  await dialog.locator('button[type="submit"]').click()
}

test('More Insert anchor preserves prose and rejects a duplicate target', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const docPath = path.join(baseDir, 'named-anchor.md')
  const initial = 'before selected prose after\r\n'
  const inserted = 'before <a name="custom"></a>selected prose after\r\n'
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
    { message: 'named-anchor fixture readiness' },
  )

  await frame.locator('body').evaluate(() => {
    const paragraph = document.querySelector('.vditor-ir p')!
    const text = paragraph.firstChild!
    const range = document.createRange()
    range.setStart(text, 'before '.length)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    ;(window as any).vditor.vditor.ir.range = range.cloneRange()
  })
  await frame.locator('.vditor-toolbar [data-type="more"]').click()
  await frame.locator('[data-type="insert-anchor"]').click()
  const dialog = frame.locator('[data-vmde-anchor-dialog]')
  await dialog.locator('input').fill('custom')
  await dialog.locator('button[type="submit"]').click()
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => (window as any).vditor.getValue() as string),
    )
    .toBe(inserted.replace('\r\n', '\n'))
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

  await frame.locator('.vditor-toolbar [data-type="more"]').click()
  await frame.locator('[data-type="insert-anchor"]').click()
  await dialog.locator('input').fill('custom')
  await dialog.locator('button[type="submit"]').click()
  await expect(dialog.locator('[data-vmde-anchor-error]')).toContainText(
    'already exists',
  )
})

test('More Insert anchor keeps a nonzero WYSIWYG repeated-prefix endpoint', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)
  const docPath = path.join(baseDir, 'named-anchor-wys-repeat.md')
  const initial = 'prefix repeated prefix repeated prefix repeated\r\n'
  const inserted =
    'prefix repeated prefix <a name="wys-repeat"></a>repeated prefix repeated\r\n'
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
    { message: 'WYSIWYG repeated-prefix named-anchor fixture readiness' },
  )
  await switchMode(frame, 'wysiwyg')
  await placeAnchorCaret(frame, 'wysiwyg', 'prefix repeated prefix ')
  await insertAnchorThroughMore(frame, 'wys-repeat')
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => (window as any).vditor.getValue() as string),
    )
    .toBe(inserted.replace('\r\n', '\n'))
  await expect.poll(() => docText(evaluateInVSCode, docPath)).toBe(inserted)
})
