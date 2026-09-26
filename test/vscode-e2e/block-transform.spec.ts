import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const BEFORE = 'before\n\nalpha **beta**\n\nafter\n'
const AFTER = 'before\n\n## alpha **beta**\n\nafter\n'

async function placeIrCaret(frame: ReturnType<typeof wf>, needle: string) {
  await frame.locator('body').evaluate((_body, text) => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    root.focus()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (
      let node = walker.nextNode() as Text | null;
      node;
      node = walker.nextNode() as Text | null
    ) {
      const index = node.data.indexOf(text)
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index + 2)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return
    }
    throw new Error(`Turn Into caret target ${text} missing`)
  }, needle)
}

test('native Turn Into QuickPick uses retained source target, one undo, and exact save', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'block-transform.md')
  writeFileSync(file, BEFORE)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
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
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      timeout: 60_000,
      message: 'Turn Into editor readiness',
    },
  )
  await placeIrCaret(frame, 'beta')
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('vmde.turnInto')
  })
  const picker = workbox.locator('.quick-input-widget input').first()
  await expect(picker).toBeVisible()
  await picker.press('Escape')
  await expect(picker).toBeHidden()
  expect(await docText(evaluateInVSCode, file)).toBe(BEFORE)
  // VS Code returns focus to the webview asynchronously after the Escape-dismissed
  // QuickPick; a late focus return would dismiss the next picker, so settle focus
  // the way a user returning to the editor does before reopening Turn Into.
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand(
      'workbench.action.focusActiveEditorGroup',
    )
  })
  await expect
    .poll(() => frame.locator('body').evaluate(() => document.hasFocus()))
    .toBe(true)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('vmde.turnInto')
  })
  await expect(picker).toBeVisible()
  await expect(
    workbox.getByRole('option', { name: /Heading 2/u }).first(),
  ).toBeVisible()
  await picker.fill('Heading 2')
  await picker.press('Enter')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(AFTER)

  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(BEFORE)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(AFTER)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(AFTER)
  frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await waitForE2EReadiness(frame, (state) => state.routerReady, {
    timeout: 60_000,
    message: 'reopened Turn Into editor readiness',
  })
  expect(readFileSync(file, 'utf8')).toBe(AFTER)
})

test('native context entry remains selection-driven under an untrusted clicked-node argument', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)
  const file = path.join(baseDir, 'block-transform-context.md')
  const before = 'alpha **beta**\n\n```ts\nconst x = 1\n```\n'
  const after = '> alpha **beta**\n\n```ts\nconst x = 1\n```\n'
  writeFileSync(file, before)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      timeout: 60_000,
      message: 'Turn Into context readiness',
    },
  )
  await expect(frame.locator('#app')).toHaveAttribute(
    'data-vscode-context',
    '{"webviewSection":"editor"}',
  )
  await expect(
    frame.locator('.vditor-ir [data-type="code-block"] pre').first(),
  ).toHaveAttribute('data-vscode-context', '{"webviewSection":"code"}')
  await placeIrCaret(frame, 'beta')
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    // Task 215's real native menu cannot be clicked by Playwright. This direct-command
    // proxy proves the forged clicked-node argument does not override the editor selection.
    await vscode.commands.executeCommand('vmde.turnInto', {
      webviewSection: 'diagram',
      lang: 'mermaid',
    })
  })
  const picker = workbox.locator('.quick-input-widget input').first()
  await expect(picker).toBeVisible()
  await expect(
    workbox.getByRole('option', { name: /Paragraph/u }).first(),
  ).toBeVisible()
  await picker.fill('Quote')
  await picker.press('Enter')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
})

test('lossy palette Turn Into asks once and applies only after native consent', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'block-transform-lossy.md')
  const before = 'alpha **beta**\n'
  const after = '```\nalpha **beta**\n```\n'
  writeFileSync(file, before)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { timeout: 60_000, message: 'lossy Turn Into readiness' },
  )
  const picker = workbox.locator('.quick-input-widget input').first()
  const requestFence = async (needle: string) => {
    await placeIrCaret(frame, needle)
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('vmde.turnInto')
    })
    await expect(picker).toBeVisible()
    await picker.fill('Code Fence')
    await picker.press('Enter')
    await expect(picker).toBeHidden()
  }
  await requestFence('beta')
  const dialog = workbox.getByRole('dialog').filter({ hasText: 'literal code' })
  await expect(dialog).toBeVisible()
  expect(await docText(evaluateInVSCode, file)).toBe(before)
  await dialog.press('Escape')
  await expect(dialog).toBeHidden()
  expect(await docText(evaluateInVSCode, file)).toBe(before)
  await requestFence('alpha')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Turn Into' }).click()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(after)
})

test('multi-block Turn Into uses one exact source transaction through native Undo and save', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'block-transform-batch.md')
  const before = 'alpha\n\nbeta\n\ngamma\n'
  const after = '## alpha\n\n## beta\n\ngamma\n'
  writeFileSync(file, before)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
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
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { timeout: 60_000, message: 'batch Turn Into readiness' },
  )
  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const blocks = root.querySelectorAll(':scope > p')
    if (blocks.length < 3) throw new Error('batch source paragraphs missing')
    const range = document.createRange()
    range.setStart(blocks[0].firstChild!, 2)
    range.setEnd(blocks[1].firstChild!, 2)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    root.focus()
    document.dispatchEvent(new Event('selectionchange'))
  })
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('vmde.turnInto')
  })
  const picker = workbox.locator('.quick-input-widget input').first()
  await expect(picker).toBeVisible()
  await picker.fill('Heading 2')
  await picker.press('Enter')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(before)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(after)
  frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await waitForE2EReadiness(frame, (state) => state.routerReady, {
    timeout: 60_000,
    message: 'reopened batch Turn Into readiness',
  })
  expect(readFileSync(file, 'utf8')).toBe(after)
})

test('handle and hidden-toolbar bubble share warning consent and exact history', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'block-transform-surfaces.md')
  const before = 'alpha\n\nbeta\n'
  const afterHandle = '```\nalpha\n```\n\nbeta\n'
  const afterBubble = '```\nalpha\n```\n\n```\nbeta\n```\n'
  writeFileSync(file, before)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.toolbar', false, vscode.ConfigurationTarget.Global)
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.selectionToolbar',
          true,
          vscode.ConfigurationTarget.Global,
        )
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  try {
    const frame = wf(workbox)
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.mode === 'ir',
      { timeout: 60_000, message: 'Turn Into handle/bubble readiness' },
    )
    await expect(
      frame.locator('.vditor-toolbar [data-type="bold"]'),
    ).toHaveCount(0)
    await frame.locator('.vditor-ir .vditor-reset > p').first().hover()
    const handle = frame.locator('.vmde-block-handle')
    await expect(handle).toBeVisible()
    await handle.click()
    await frame
      .locator('.vmde-block-handle-menu [data-action="turnInto"]')
      .click()
    const picker = workbox.locator('.quick-input-widget input').first()
    await expect(picker).toBeVisible()
    await picker.fill('Code Fence')
    await picker.press('Enter')
    const warning = workbox
      .getByRole('dialog')
      .filter({ hasText: 'literal code' })
    await expect(warning).toBeVisible()
    expect(await docText(evaluateInVSCode, file)).toBe(before)
    await warning.getByRole('button', { name: 'Turn Into' }).click()
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(afterHandle)

    await frame
      .locator('.vditor-ir .vditor-reset > p')
      .last()
      .evaluate((element) => {
        const text = element.firstChild!
        const range = document.createRange()
        range.setStart(text, 0)
        range.setEnd(text, 4)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
    const bubble = frame.locator('.vmde-selection-bubble')
    await expect(bubble).toBeVisible()
    await bubble.getByRole('button', { name: 'Turn Into' }).click()
    const menu = bubble.locator('.vmde-selection-bubble-menu')
    await menu.getByRole('menuitemradio', { name: '⚠ Code Fence' }).click()
    await expect(warning).toBeVisible()
    expect(await docText(evaluateInVSCode, file)).toBe(afterHandle)
    await warning.getByRole('button', { name: 'Turn Into' }).click()
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(afterBubble)

    await frame
      .locator('.vditor-ir')
      .first()
      .click({ position: { x: 4, y: 4 } })
    await workbox.keyboard.press('Control+z')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(afterHandle)
    await frame
      .locator('.vditor-ir')
      .first()
      .click({ position: { x: 4, y: 4 } })
    await workbox.keyboard.press('Control+z')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(before)
    await frame
      .locator('.vditor-ir')
      .first()
      .click({ position: { x: 4, y: 4 } })
    await workbox.keyboard.press('Control+y')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(afterHandle)
    await frame
      .locator('.vditor-ir')
      .first()
      .click({ position: { x: 4, y: 4 } })
    await workbox.keyboard.press('Control+y')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(afterBubble)
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    })
    expect(readFileSync(file, 'utf8')).toBe(afterBubble)
  } finally {
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.toolbar', undefined, vscode.ConfigurationTarget.Global)
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.selectionToolbar',
          undefined,
          vscode.ConfigurationTarget.Global,
        )
    })
  }
})

test('current Code Fence menu edits language through native input with exact undo', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(150_000)
  const file = path.join(baseDir, 'block-transform-language.md')
  const before = '```js\nalpha\n```\n'
  const after = '```ts\nalpha\n```\n'
  writeFileSync(file, before)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { timeout: 60_000, message: 'fence language Turn Into readiness' },
  )
  await placeIrCaret(frame, 'alpha')
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('vmde.turnInto')
  })
  const input = workbox.locator('.quick-input-widget input').first()
  await expect(input).toBeVisible()
  await input.fill('Code Fence')
  await input.press('Enter')
  await expect(input).toHaveValue('js')
  await input.fill('ts')
  await input.press('Enter')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(before)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(after)
})

test('callout to quote warns about metadata loss and preserves exact Undo/save', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(150_000)
  const file = path.join(baseDir, 'block-transform-callout.md')
  const before = '> [!NOTE]- Title\n> body **exact**\n'
  const after = '> body **exact**\n'
  writeFileSync(file, before)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { timeout: 60_000, message: 'callout Turn Into readiness' },
  )
  await placeIrCaret(frame, 'body')
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('vmde.turnInto')
  })
  const picker = workbox.locator('.quick-input-widget input').first()
  await expect(picker).toBeVisible()
  await picker.fill('Quote')
  await picker.press('Enter')
  const warning = workbox
    .getByRole('dialog')
    .filter({ hasText: 'callout type' })
  await expect(warning).toBeVisible()
  expect(await docText(evaluateInVSCode, file)).toBe(before)
  await warning.getByRole('button', { name: 'Turn Into' }).click()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(before)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(after)
})
