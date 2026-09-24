import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const AUTHOR = `${[
  '# Heading',
  '',
  'Before [A long label](https://example.com/a "kept title") after.',
  '',
  '|  left  | right |',
  '| :--- | ---: |',
  '| x | y |',
  '',
  '```js',
  'const x = 1',
  '```',
].join('\r\n')}\r\n`
const EDITED = AUTHOR.replace(
  'https://example.com/a',
  'https://changed.example/path',
)
const UNLINKED = AUTHOR.replace(
  '[A long label](https://example.com/a "kept title")',
  'A long label',
)

async function openEditor(
  evaluateInVSCode: (fn: unknown, args: [string]) => Promise<unknown>,
  file: string,
) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file],
  )
}

function linkLabel(frame: ReturnType<typeof wf>) {
  return frame.locator('.vditor-ir [data-type="a"] .vditor-ir__link').first()
}

async function focusEditor(frame: ReturnType<typeof wf>) {
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
}

async function installPointerTrace(frame: ReturnType<typeof wf>) {
  await frame.locator('body').evaluate(() => {
    const entries: Array<Record<string, unknown>> = []
    ;(window as any).__task297PointerTrace = entries
    const record = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null
      entries.push({
        event: event.type,
        target:
          target?.closest('[data-type]')?.getAttribute('data-type') ?? null,
        defaultPrevented: event.defaultPrevented,
        linkExpanded: Boolean(
          document.querySelector(
            '.vditor-ir [data-type="a"].vditor-ir__node--expand',
          ),
        ),
        imageExpanded: Boolean(
          document.querySelector(
            '.vditor-ir [data-type="img"].vditor-ir__node--expand',
          ),
        ),
        selectionCollapsed: getSelection()?.isCollapsed,
      })
    }
    window.addEventListener('pointerdown', record, true)
    for (const name of ['mousedown', 'selectionchange', 'click'])
      document.addEventListener(name, record, true)
  })
}

test('real IR link balloon keeps authored CRLF and table bytes through Copy, Edit, Unlink and history', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'link-popover.md')
  writeFileSync(file, AUTHOR)
  await openEditor(evaluateInVSCode, file)
  let frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { timeout: 60_000, message: 'Task 297 link popover readiness' },
  )
  const label = linkLabel(frame)
  const paragraph = frame.locator('.vditor-ir .vditor-reset p').first()
  const heightBefore = await paragraph.evaluate(
    (element) => element.getBoundingClientRect().height,
  )
  const renderedBefore = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue())
  expect(renderedBefore).not.toBe(AUTHOR)
  await installPointerTrace(frame)
  await label.click()
  const linkEvents = await frame.locator('body').evaluate(
    () =>
      (window as any).__task297PointerTrace as Array<{
        event: string
        target: string | null
        linkExpanded: boolean
      }>,
  )
  expect(linkEvents[0]).toMatchObject({
    event: 'pointerdown',
    target: 'a',
    linkExpanded: false,
  })
  expect(linkEvents.some((event) => event.linkExpanded)).toBe(false)
  const popover = frame.locator('.vmde-link-popover')
  await expect(popover).toBeVisible()
  await expect(label.locator('..')).not.toHaveClass(/vditor-ir__node--expand/u)
  expect(
    await paragraph.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
  ).toBe(heightBefore)
  const geometry = await popover.evaluate((element) => {
    const panel = element.getBoundingClientRect()
    const content = document
      .querySelector('.vditor-content')!
      .getBoundingClientRect()
    const toolbar = document
      .querySelector('.vditor-toolbar')!
      .getBoundingClientRect()
    const label = document
      .querySelector('.vditor-ir__link')!
      .getBoundingClientRect()
    return {
      panel: {
        left: panel.left,
        right: panel.right,
        top: panel.top,
        bottom: panel.bottom,
      },
      content: {
        left: content.left,
        right: content.right,
        top: content.top,
        bottom: content.bottom,
      },
      toolbarBottom: toolbar.bottom,
      label: { top: label.top, bottom: label.bottom },
    }
  })
  expect(geometry.panel.left).toBeGreaterThanOrEqual(geometry.content.left)
  expect(geometry.panel.right).toBeLessThanOrEqual(geometry.content.right)
  expect(geometry.panel.top).toBeGreaterThanOrEqual(geometry.toolbarBottom)
  expect(geometry.panel.top).toBeGreaterThanOrEqual(geometry.label.bottom + 2)
  expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.content.bottom)
  expect(await docText(evaluateInVSCode, file)).toBe(AUTHOR)

  await popover.getByRole('button', { name: 'Copy URL' }).click()
  const clipboard = await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => vscode.env.clipboard.readText(),
    [file],
  )
  expect(clipboard).toBe('https://example.com/a')
  expect(await docText(evaluateInVSCode, file)).toBe(AUTHOR)

  await linkLabel(frame).click()
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: 'Edit URL' }).click()
  await popover
    .getByRole('textbox', { name: 'URL' })
    .fill('https://changed.example/path')
  await popover.getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(EDITED)
  await focusEditor(frame)
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(AUTHOR)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(EDITED)

  await linkLabel(frame).click()
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: 'Unlink' }).click()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(UNLINKED)
  await focusEditor(frame)
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(EDITED)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(UNLINKED)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    },
    [file],
  )
  expect(readFileSync(file, 'utf8')).toBe(UNLINKED)
  frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await waitForE2EReadiness(frame, (state) => state.routerReady, {
    timeout: 60_000,
    message: 'reopened Task 297 link popover readiness',
  })
  expect(readFileSync(file, 'utf8')).toBe(UNLINKED)
})

test('real IR image Edit/Unlink stays exact and link Open keeps modifier and legacy policy', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'link-popover-image.md')
  const targetFile = path.join(baseDir, 'target.md')
  const before =
    'Before ![second **alt**](https://same.test/a "title") after.\n\n[Local](./target.md)\n'
  const edited = before.replace('https://same.test/a', 'https://changed.test/b')
  const unlinked = before.replace(
    '![second **alt**](https://same.test/a "title")',
    'second **alt**',
  )
  writeFileSync(file, before)
  writeFileSync(targetFile, '# Local target\n')
  await openEditor(evaluateInVSCode, file)
  let frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { timeout: 60_000, message: 'Task 297 image popover readiness' },
  )
  const image = frame.locator('.vditor-ir [data-type="img"] img').first()
  await installPointerTrace(frame)
  await image.click()
  const imageEvents = await frame.locator('body').evaluate(
    () =>
      (window as any).__task297PointerTrace as Array<{
        event: string
        target: string | null
        imageExpanded: boolean
      }>,
  )
  expect(imageEvents[0]).toMatchObject({
    event: 'pointerdown',
    target: 'img',
    imageExpanded: false,
  })
  expect(imageEvents.some((event) => event.imageExpanded)).toBe(false)
  const popover = frame.locator('.vmde-link-popover')
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: 'Edit URL' }).click()
  await popover
    .getByRole('textbox', { name: 'URL' })
    .fill('https://changed.test/b')
  await popover.getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(edited)
  await frame.locator('.vditor-ir [data-type="img"] img').first().click()
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: 'Unlink' }).click()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(unlinked)
  await focusEditor(frame)
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(edited)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(unlinked)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    },
    [file],
  )
  expect(readFileSync(file, 'utf8')).toBe(unlinked)

  const activeTabPath = () =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode')) =>
        (
          vscode.window.tabGroups.activeTabGroup.activeTab?.input as
            | { uri?: { fsPath?: string } }
            | undefined
        )?.uri?.fsPath ?? '',
      [file],
    )
  await frame
    .locator('.vditor-ir [data-type="a"] .vditor-ir__link')
    .first()
    .click()
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: 'Open', exact: true }).click()
  await expect.poll(activeTabPath).toBe(targetFile)
  frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await waitForE2EReadiness(frame, (state) => state.routerReady, {
    timeout: 60_000,
    message: 'reopened Task 297 modifier link readiness',
  })
  await frame
    .locator('.vditor-ir [data-type="a"] .vditor-ir__link')
    .first()
    .click({
      modifiers: ['Control'],
    })
  await expect.poll(activeTabPath).toBe(targetFile)

  try {
    await evaluateInVSCode(
      async (vscode: typeof import('vscode')) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update(
            'editor.modifierClickLinks',
            false,
            vscode.ConfigurationTarget.Global,
          )
      },
      [file],
    )
    frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
    await waitForE2EReadiness(frame, (state) => state.routerReady, {
      timeout: 60_000,
      message: 'reopened Task 297 legacy link readiness',
    })
    await frame
      .locator('.vditor-ir [data-type="a"] .vditor-ir__link')
      .first()
      .click()
    await expect.poll(activeTabPath).toBe(targetFile)
  } finally {
    await evaluateInVSCode(
      async (vscode: typeof import('vscode')) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update(
            'editor.modifierClickLinks',
            undefined,
            vscode.ConfigurationTarget.Global,
          )
      },
      [file],
    )
  }
  expect(readFileSync(file, 'utf8')).toBe(unlinked)
})
