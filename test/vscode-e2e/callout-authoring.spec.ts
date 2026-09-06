import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

test('callout authoring stays source-derived across toolbar, IR, WYSIWYG, and SV', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const docPath = path.join(baseDir, 'callout-authoring.md')
  writeFileSync(docPath, 'alpha body\n')
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

  const docText = () =>
    evaluateInVSCode(
      async (vscode, args: [string]) =>
        vscode.workspace.textDocuments
          .find((document) => document.uri.fsPath === args[0])
          ?.getText() ?? '',
      [docPath] as [string],
    ) as Promise<string>

  async function placeCaret(mode: 'ir' | 'wysiwyg' | 'sv', needle: string) {
    const surface = frame.locator(`.vditor-${mode}`).first()
    const callout = frame
      .locator(`.vditor-${mode} blockquote[data-callout]`)
      .filter({ hasText: needle })
      .first()
    if (mode === 'ir' && (await callout.count())) {
      await callout.click()
    } else {
      await surface.click({ position: { x: 5, y: 5 } })
    }
    await surface.evaluate((editor, target) => {
      ;(editor as HTMLElement).focus({ preventScroll: true })
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(target)
        if (index < 0) continue
        const range = document.createRange()
        range.setStart(node, index + target.length)
        range.collapse(true)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        ;(window as any).__vmdeRequestCaret?.({
          node: range.startContainer,
          offset: range.startOffset,
        })
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      throw new Error(`${target} not found in active editor`)
    }, needle)
  }

  async function switchMode(mode: 'ir' | 'wysiwyg' | 'sv') {
    await frame.locator('body').evaluate((_body, next) => {
      const inner = (window as any).vditor.vditor
      if (inner.currentMode === next) return
      inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
      document
        .querySelector(`button[data-mode="${next}"]`)
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

  const toolbarPanel = frame.locator('.vmde-callout-toolbar-panel')
  const waitForPanelStability = (panel: ReturnType<typeof frame.locator>) =>
    panel.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
  const applyToolbarCallout = (type: string, title: string) =>
    toolbarPanel.evaluate(
      (panel, values: { type: string; title: string }) => {
        ;(panel.querySelector('select') as HTMLSelectElement).value =
          values.type
        ;(panel.querySelector('input') as HTMLInputElement).value = values.title
        ;(
          panel.querySelector('.vmde-callout__apply') as HTMLButtonElement
        ).click()
      },
      { type, title },
    )

  await placeCaret('ir', 'alpha body')
  await frame.locator('.vditor-toolbar [data-type="callout"]').click()
  await waitForPanelStability(toolbarPanel)
  await expect(toolbarPanel).toBeVisible()
  await applyToolbarCallout('note', 'Created')
  let expected = '> [!NOTE] Created\n> alpha body\n'
  await expect.poll(docText, { timeout: 20_000 }).toBe(expected)
  await expect(
    frame.locator('.vditor-ir blockquote[data-callout="note"]'),
  ).toContainText('alpha body')

  await placeCaret('ir', 'alpha body')
  await workbox.keyboard.type(' edited')
  expected = expected.replace('alpha body', 'alpha body edited')
  await expect.poll(docText, { timeout: 20_000 }).toBe(expected)

  await placeCaret('ir', 'alpha body edited')
  const irPanel = frame.locator('.vmde-callout-context-panel')
  await workbox.keyboard.press('Control+Enter')
  await expect(irPanel).toBeVisible()
  await expect(irPanel.locator('select')).toBeFocused()
  await irPanel.locator('select').selectOption('warning')
  await irPanel.locator('input').fill('IR title')
  await expect(irPanel.locator('input')).toHaveValue('IR title')
  await irPanel.getByRole('button', { name: 'Apply' }).click()
  expected = '> [!WARNING] IR title\n> alpha body edited\n'
  await expect.poll(docText, { timeout: 20_000 }).toBe(expected)

  await workbox.keyboard.press('Escape')

  await switchMode('wysiwyg')
  await placeCaret('wysiwyg', 'alpha body edited')
  await frame.locator('.vditor-wysiwyg blockquote').click()
  const wysControls = frame
    .locator('.vditor-panel:visible .vmde-callout-controls')
    .last()
  await expect(wysControls).toBeVisible()
  await wysControls.locator('select').selectOption('tip')
  await wysControls.locator('input').fill('WYS title')
  await expect(wysControls.locator('input')).toHaveValue('WYS title')
  await wysControls.getByRole('button', { name: 'Apply' }).click()
  expected = '> [!TIP] WYS title\n> alpha body edited\n'
  await expect.poll(docText, { timeout: 20_000 }).toBe(expected)

  await switchMode('sv')
  await expect(frame.locator('.vditor-sv')).toContainText('[!TIP] WYS title')
  await placeCaret('sv', 'alpha body edited')
  await frame.locator('.vditor-toolbar [data-type="callout"]').click()
  await waitForPanelStability(toolbarPanel)
  await applyToolbarCallout('caution', 'SV title')
  expected = '> [!CAUTION] SV title\n> alpha body edited\n\n'
  await expect.poll(docText, { timeout: 20_000 }).toBe(expected)

  await switchMode('ir')
  await placeCaret('ir', 'alpha body edited')
  await frame.locator('.vditor-toolbar [data-type="callout"]').click()
  await expect(toolbarPanel.locator('select')).toHaveValue('caution')
  await expect(toolbarPanel.locator('input')).toHaveValue('SV title')
  await toolbarPanel.getByRole('button', { name: 'Remove Callout' }).click()
  const removed = '> alpha body edited\n'
  await expect.poll(docText, { timeout: 20_000 }).toBe(removed)
  await workbox.keyboard.press('Control+z')
  expected = '> [!CAUTION] SV title\n> alpha body edited\n\n'
  await expect.poll(docText, { timeout: 20_000 }).toBe(expected)

  const leaked = await frame
    .locator('body')
    .evaluate(() =>
      (window as any).vditor.getValue().includes('vmde-callout-controls'),
    )
  expect(leaked).toBe(false)

  await frame.locator('.vditor-toolbar').evaluate((toolbar) => {
    ;(toolbar as HTMLElement).style.width = '280px'
    window.dispatchEvent(new Event('resize'))
  })
  await expect(
    frame.locator('.vmde-toolbar-more .vditor-hint [data-type="callout"]'),
  ).toHaveCount(1)

  await workbox.keyboard.press('Control+s')
  await expect
    .poll(() => readFileSync(docPath, 'utf8'), { timeout: 20_000 })
    .toBe(expected)
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath] as [string],
  )
  await frame.locator('blockquote[data-callout="caution"]').waitFor({
    timeout: 60_000,
  })
  await expect.poll(docText, { timeout: 20_000 }).toBe(expected)
})
