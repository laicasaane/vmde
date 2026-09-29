import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import type { Locator, TestInfo } from '@playwright/test'
import { createXtestInput } from './helpers/xtest-input'
import {
  FIXTURE,
  FIXTURE_SHA256,
  literalMatches,
} from './find-replace-fixture-helpers'
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

    // Start a new user selection so Turn Into's caret restoration yields before the range setup.
    await frame.locator('.vditor-ir .vditor-reset > p').last().click()
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

// Retain only structural/boolean selection evidence. Find input focus may change the document
// Selection's presentation; the command's exact edit remains the action oracle.
async function attachFindSelectionState(
  editor: Locator,
  token: string,
  testInfo: TestInfo,
) {
  const selectionState = await editor.evaluate((root, query) => {
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const anchor = selection?.anchorNode
    const parent = anchor instanceof Element ? anchor : anchor?.parentElement
    return {
      findFocused: Boolean(
        document.activeElement?.closest('.vmde-find-replace'),
      ),
      rangeCount: selection?.rangeCount ?? 0,
      selectionCollapsed: selection?.isCollapsed ?? null,
      anchorWithinEditor: Boolean(anchor && root.contains(anchor)),
      anchorBlockTag: parent?.closest('[data-block]')?.tagName ?? null,
      selectionMatchesToken: selection?.toString().toLowerCase() === query,
      rangeWithinEditor: Boolean(
        range &&
          root.contains(range.startContainer) &&
          root.contains(range.endContainer),
      ),
      rangeCollapsed: range?.collapsed ?? null,
      rangeMatchesToken: range?.toString().toLowerCase() === query,
    }
  }, token)
  const evidence = testInfo.outputPath(
    'find-turn-into-selection-before-command.json',
  )
  writeFileSync(evidence, JSON.stringify(selectionState, null, 2))
  await testInfo.attach('find-turn-into-selection-before-command', {
    path: evidence,
    contentType: 'application/json',
  })
}

test('Task 579 Find Next retains a round-tripping paragraph for Turn Into, one Undo and exact save', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  baseDir,
}, testInfo) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )
  test.setTimeout(180_000)
  // Owner-approved single small Find fixture: both IR source versions round-trip exactly.
  const initial = 'before\n\nalpha token\n\nafter token\n'
  const transformed = 'before\n\nalpha token\n\n## after token\n'
  const file = path.join(baseDir, 'find-turn-into-roundtrip.md')
  writeFileSync(file, initial)
  await evaluateInVSCode(async (vscode) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.defaultMode', 'ir', true)
  })
  await evaluateInVSCode(
    async (vscode, [uri]: [string]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    {
      timeout: 90_000,
      message: 'Find Turn Into roundtrip editor readiness',
    },
  )
  const host = () => docText(evaluateInVSCode, file)
  await expect.poll(async () => (await host()) === initial).toBe(true)
  const editor = frame.locator('#app .vditor-ir .vditor-reset').first()
  const xtest = await createXtestInput(electronApp, workbox)
  await xtest.activateAndFocus()
  await editor.focus()
  await expect(editor).toBeFocused()
  await xtest.key('ctrl+f')
  const widget = frame.locator('.vmde-find-replace')
  const find = widget.locator('[data-find]')
  await expect(find).toBeFocused()
  await xtest.key('ctrl+a')
  await xtest.type('token', 20)
  await expect(find).toHaveValue('token')
  await expect(widget.locator('[data-status]')).toHaveText('1 of 2')
  await xtest.key('F3')
  await expect(widget.locator('[data-status]')).toHaveText('2 of 2')
  await expect(find).toBeFocused()
  await attachFindSelectionState(editor, 'token', testInfo)

  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.turnInto')
  })
  const picker = workbox.locator('.quick-input-widget input').first()
  await expect(picker).toBeVisible()
  await expect(
    workbox.getByRole('option', { name: /Heading 2/u }).first(),
  ).toBeVisible()
  await picker.focus()
  await expect(picker).toBeFocused()
  await xtest.type('Heading 2', 20)
  await expect(picker).toHaveValue('Heading 2')
  await xtest.key('Return')
  await expect(picker).toBeHidden()
  await expect.poll(async () => (await host()) === transformed).toBe(true)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8') === transformed).toBe(true)
  await editor.focus()
  await expect(editor).toBeFocused()
  await xtest.key('ctrl+z')
  await expect.poll(async () => (await host()) === initial).toBe(true)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8') === initial).toBe(true)
})

test('Task 604 non-round-tripping paragraph opens Turn Into equally from Find and editor selection, with exact save and one Undo', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  baseDir,
}, testInfo) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )
  test.setTimeout(180_000)
  const initial = FIXTURE
  expect(createHash('sha256').update(initial).digest('hex')).toBe(
    FIXTURE_SHA256,
  )
  const token = 'mtnnwcr'
  const matches = literalMatches(initial, token, false)
  expect(matches).toHaveLength(2)
  const farStart = initial.lastIndexOf('\n', matches[1].start - 1) + 1
  const farEnd = initial.indexOf('\n', matches[1].end)
  const farParagraph = initial.slice(farStart, farEnd)
  const transformed = `${initial.slice(0, farStart)}## ${initial.slice(farStart)}`
  const file = path.join(baseDir, 'find-turn-into-large-parity.md')
  writeFileSync(file, initial)
  await evaluateInVSCode(async (vscode) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.defaultMode', 'ir', true)
  })
  await evaluateInVSCode(
    async (vscode, [uri]: [string]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    {
      timeout: 90_000,
      message: 'Find Turn Into large parity editor readiness',
    },
  )
  const host = () => docText(evaluateInVSCode, file)
  await expect.poll(async () => (await host()) === initial).toBe(true)
  const editor = frame.locator('#app .vditor-ir .vditor-reset').first()
  const xtest = await createXtestInput(electronApp, workbox)
  await xtest.activateAndFocus()
  await editor.focus()
  await expect(editor).toBeFocused()
  await xtest.key('ctrl+f')
  const widget = frame.locator('.vmde-find-replace')
  const find = widget.locator('[data-find]')
  await expect(find).toBeFocused()
  await xtest.key('ctrl+a')
  await xtest.type(token, 20)
  await expect(find).toHaveValue(token)
  await expect(widget.locator('[data-status]')).toHaveText('1 of 2')
  await xtest.key('F3')
  await expect(widget.locator('[data-status]')).toHaveText('2 of 2')
  await expect(find).toBeFocused()
  await attachFindSelectionState(editor, token, testInfo)
  const picker = workbox.locator('.quick-input-widget input').first()
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.turnInto')
  })
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await expect(picker).toHaveAttribute('placeholder', 'Current: Paragraph')
  await expect(
    workbox.getByRole('option', { name: /Heading 2/u }).first(),
  ).toBeVisible()
  await picker.focus()
  await expect(picker).toBeFocused()
  await xtest.key('Escape')
  await expect(picker).toBeHidden()
  expect((await host()) === initial).toBe(true)

  // Escape can also close Find through its host binding. Re-enter through the real command;
  // Task 599 owns close-time selection restoration, and the next leg selects its own range.
  await xtest.activateAndFocus()
  await editor.focus()
  await expect(editor).toBeFocused()
  await xtest.key('ctrl+f')
  await expect(widget).toBeVisible()
  await expect(find).toBeFocused()
  await xtest.key('Escape')
  await expect(widget).toBeHidden()
  await editor.evaluate(
    async (root, { query, fragment }) => {
      const findTarget = () => {
        const matches = Array.from(
          root.querySelectorAll(':scope > p[data-block]'),
        ).filter((candidate) => candidate.textContent === fragment)
        if (matches.length !== 1) throw new Error('Far paragraph is not unique')
        const paragraph = matches[0]
        const walker = document.createTreeWalker(
          paragraph,
          NodeFilter.SHOW_TEXT,
        )
        for (
          let node = walker.nextNode() as Text | null;
          node;
          node = walker.nextNode() as Text | null
        ) {
          const offset = node.data.toLowerCase().indexOf(query)
          if (offset >= 0) return { paragraph, target: node, offset }
        }
        throw new Error('Target text node missing')
      }
      const { paragraph, target, offset } = findTarget()
      paragraph.scrollIntoView({ block: 'center' })
      ;(root as HTMLElement).focus({ preventScroll: true })
      const requestCaret = (window as any).__vmdeRequestCaret
      if (typeof requestCaret !== 'function')
        throw new Error('Caret authority bridge missing')
      requestCaret({
        anchor: { node: target, offset },
        focus: { node: target, offset: offset + query.length },
      })
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      const selection = getSelection()
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null
      if (
        !range ||
        !root.contains(range.startContainer) ||
        range.toString().toLowerCase() !== query
      )
        throw new Error('Target paragraph selection moved before Turn Into')
    },
    { query: token, fragment: farParagraph },
  )
  await expect(editor).toBeFocused()
  const undoDepth = () =>
    frame
      .locator('body')
      .evaluate(
        () => (window as any).vditor.vditor.undo.ir.undoStack.length as number,
      )
  await expect.poll(undoDepth, { timeout: 10_000 }).toBeGreaterThan(0)
  const openingUndoDepth = await undoDepth()
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.turnInto')
  })
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await expect(picker).toHaveAttribute('placeholder', 'Current: Paragraph')
  await picker.focus()
  await expect(picker).toBeFocused()
  await xtest.key('ctrl+a')
  await xtest.type('Heading 2', 20)
  await expect(picker).toHaveValue('Heading 2')
  await xtest.key('Return')
  await expect(picker).toBeHidden()
  await expect
    .poll(async () => (await host()) === transformed, { timeout: 20_000 })
    .toBe(true)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8') === transformed).toBe(true)
  await expect
    .poll(undoDepth, { timeout: 10_000 })
    .toBeGreaterThan(openingUndoDepth)
  await editor.focus()
  await expect(editor).toBeFocused()
  await xtest.key('ctrl+z')
  await expect
    .poll(async () => (await host()) === initial, { timeout: 20_000 })
    .toBe(true)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8') === initial).toBe(true)
  await expect
    .poll(
      () =>
        frame
          .locator('body')
          .evaluate(
            (_body, source) =>
              (window as any).__vmdeE2EExactMarkdown() === source,
            initial,
          ),
      { timeout: 5_000 },
    )
    .toBe(true)
})
