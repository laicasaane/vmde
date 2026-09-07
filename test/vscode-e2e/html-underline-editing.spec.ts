import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput, type XtestInput } from './helpers/xtest-input'
import {
  docText,
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const INITIAL = [
  'Before x<INS title="authored">**added** &amp;</INS>y.',
  '',
  'Action x2y.',
  '',
  'XTEST target.',
  '',
].join('\r\n')

const host = (text: string) => text

async function keys(
  xtest: XtestInput,
  keysym: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index++) await xtest.key(keysym)
}

async function openFixture(
  evaluateInVSCode: Parameters<typeof docText>[0],
  file: string,
): Promise<void> {
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
}

async function selectActionCharacterByXtest(
  frame: ReturnType<typeof wf>,
  xtest: XtestInput,
): Promise<void> {
  await frame.locator('.vditor-ir p').filter({ hasText: 'Action x2y.' }).click()
  await xtest.key('Home')
  await keys(xtest, 'Right', 9)
  await xtest.key('Shift+Left')
}

async function switchToWysiwyg(frame: ReturnType<typeof wf>): Promise<void> {
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="wysiwyg"]').click()
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'wysiwyg',
    { message: 'HTML INS WYSIWYG readiness' },
  )
}

test('XTEST real-VS-Code HTML INS preserves an IR source selection through Preview, undo, and redo', async ({
  electronApp,
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires the explicit XTEST runner',
  )
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'html-underline-editing.md')
  writeFileSync(file, INITIAL)
  await openFixture(evaluateInVSCode, file)

  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { message: 'HTML INS XTEST IR readiness' },
  )
  await expect(
    frame.locator('.vditor-ir ins[data-vmde-html-underline="1"]'),
  ).toHaveCount(1)

  const xtest = await createXtestInput(electronApp, workbox)
  expect(xtest.client.visible).toBe(true)
  await frame
    .locator('.vditor-ir p')
    .filter({ hasText: 'XTEST target.' })
    .click()
  await xtest.type('OS')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toContain('XTEST target.OS')

  const underline = frame.locator('.vditor-toolbar [data-type="underline"]')
  const beforePreview = await docText(evaluateInVSCode, file)
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  await frame.locator('.vditor-preview').first().waitFor({ timeout: 30_000 })
  await expect(underline).toBeDisabled()
  await frame
    .locator('body')
    .evaluate(() => document.dispatchEvent(new Event('vmde-toggle-underline')))
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(beforePreview)
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { message: 'HTML INS Preview exit readiness' },
  )

  await selectActionCharacterByXtest(frame, xtest)
  await expect(underline).toBeEnabled()
  await underline.click()
  const direction = await frame.locator('body').evaluate(() => {
    const selection = getSelection()!
    const anchor = document.createRange()
    anchor.setStart(selection.anchorNode!, selection.anchorOffset)
    anchor.collapse(true)
    const focus = document.createRange()
    focus.setStart(selection.focusNode!, selection.focusOffset)
    focus.collapse(true)
    return {
      text: selection.toString(),
      backward: anchor.compareBoundaryPoints(Range.START_TO_START, focus) > 0,
    }
  })
  expect(direction).toEqual({ text: '2', backward: true })
  const wrapped = INITIAL.replace(
    'Action x2y.',
    'Action x<ins>2</ins>y.',
  ).replace('XTEST target.', 'XTEST target.OS')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(host(wrapped))

  await xtest.key('ctrl+z')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(host(INITIAL.replace('XTEST target.', 'XTEST target.OS')))
  await xtest.key('ctrl+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(host(wrapped))
})

test('XTEST real-VS-Code HTML INS keeps exact CRLF bytes through WYSIWYG save and reopen', async ({
  electronApp,
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires the explicit XTEST runner',
  )
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'html-underline-roundtrip.md')
  writeFileSync(file, INITIAL)
  await openFixture(evaluateInVSCode, file)

  let frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { message: 'HTML INS exact-source readiness' },
  )
  const xtest = await createXtestInput(electronApp, workbox)
  const underline = frame.locator('.vditor-toolbar [data-type="underline"]')
  await frame.locator('.vditor-ir p').filter({ hasText: 'Action x2y.' }).click()
  await xtest.key('Home')
  await keys(xtest, 'Right', 8)
  await expect(underline).toBeEnabled()
  await underline.click()
  const inserted = INITIAL.replace('Action x2y.', 'Action x<ins></ins>2y.')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(host(inserted))
  await xtest.type('z')
  const insertedCharacter = inserted.replace('<ins></ins>', '<ins>z</ins>')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(host(insertedCharacter))

  await switchToWysiwyg(frame)
  await expect(
    frame.locator('.vditor-wysiwyg ins[data-vmde-html-underline="1"]'),
  ).toHaveCount(2)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(insertedCharacter)
  await evaluateInVSCode(
    async (vscode, args: [string, string, string]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [file, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )
  frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'wysiwyg',
    { message: 'HTML INS reopen readiness' },
  )
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(host(insertedCharacter))
  await expect(
    frame.locator('.vditor-wysiwyg ins[data-vmde-html-underline="1"]'),
  ).toHaveCount(2)
})

test('XTEST narrow More menu activates Underline by OS keyboard', async ({
  electronApp,
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires the explicit XTEST runner',
  )
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'html-underline-more.md')
  writeFileSync(file, 'Keyboard x2y.\r\n')
  await openFixture(evaluateInVSCode, file)

  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { message: 'HTML INS More readiness' },
  )
  let overflow: string[] = []
  for (const width of [600, 520, 480, 440, 400]) {
    await workbox.setViewportSize({ width, height: 800 })
    overflow = await frame
      .locator('.vditor-toolbar')
      .evaluate((toolbar) =>
        Array.from(
          toolbar.querySelectorAll<HTMLElement>(
            '[data-vmde-overflow="true"] > [data-type]',
          ),
        ).map((item) => item.dataset.type ?? ''),
      )
    if (overflow.includes('underline')) break
  }
  expect(overflow).toEqual(
    expect.arrayContaining(['subscript', 'superscript', 'underline']),
  )

  const xtest = await createXtestInput(electronApp, workbox)
  await frame
    .locator('.vditor-ir p')
    .filter({ hasText: 'Keyboard x2y.' })
    .click()
  await xtest.key('Home')
  await keys(xtest, 'Right', 10)
  await xtest.key('Shift+Right')
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => getSelection()?.toString()),
    )
    .toBe('2')
  await xtest.key('Escape')
  await xtest.key('Tab')

  const arrowsTo = async (target: string, menu = false) =>
    frame.locator('body').evaluate(
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: reads roving focus from the live toolbar or its reparented More menu before XTEST advances it.
      (_body, { target, menu }) => {
        const root = menu
          ? document.querySelector('.vmde-toolbar-more > .vditor-hint')
          : document.querySelector('.vditor-toolbar')
        if (!root) throw new Error(`Missing ${menu ? 'More menu' : 'toolbar'}`)
        const items = Array.from(
          root.querySelectorAll<HTMLElement>(
            menu
              ? '[data-vmde-overflow="true"] [data-type]'
              : ':scope .vditor-toolbar__item > [data-type]',
          ),
        ).filter(
          (item) =>
            getComputedStyle(item).display !== 'none' &&
            (menu || item.closest('.vditor-hint') === null),
        )
        const from = items.indexOf(document.activeElement as HTMLElement)
        const to = items.findIndex((item) => item.dataset.type === target)
        if (from < 0 || to < 0)
          throw new Error(
            `Could not focus ${target} through ${menu ? 'More menu' : 'toolbar'}`,
          )
        return (to - from + items.length) % items.length
      },
      { target, menu },
    )
  await keys(xtest, 'Right', await arrowsTo('more'))
  await xtest.key('Return')
  await expect(frame.locator('.vmde-toolbar-more > .vditor-hint')).toBeVisible()
  await xtest.key('Tab')
  await keys(xtest, 'Down', await arrowsTo('underline', true))
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(
          () => (document.activeElement as HTMLElement | null)?.dataset.type,
        ),
    )
    .toBe('underline')
  await xtest.key('Return')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(host('Keyboard x<ins>2</ins>y.\r\n'))
})
