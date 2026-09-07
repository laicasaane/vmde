import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput, type XtestInput } from './helpers/xtest-input'
import {
  docText,
  ExtensionId,
  MarkdownEditorViewType,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const INITIAL = [
  'Before H<sub title="authored">2</sub>O.',
  '',
  'Action H2O.',
  '',
  'XTEST target.',
  '',
  'Tilde #~stay~#.',
  '',
  '| Left | Right |',
  '| --- | --- |',
  '|  keep  | H2O     |',
  '',
].join('\r\n')

const host = (text: string) => text

async function keyTimes(
  xtest: XtestInput,
  keysym: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index++) await xtest.key(keysym)
}

async function selectActionCharacterByXtest(
  frame: ReturnType<typeof wf>,
  xtest: XtestInput,
): Promise<void> {
  await frame.locator('.vditor-ir p').filter({ hasText: 'Action H2O.' }).click()
  await xtest.key('Home')
  await keyTimes(xtest, 'Right', 9)
  await xtest.key('Shift+Left')
}

async function selectActionWrapper(
  frame: ReturnType<typeof wf>,
): Promise<void> {
  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const paragraph = Array.from(root.querySelectorAll('p')).find((candidate) =>
      candidate.textContent?.includes('Action H'),
    )!
    const markers = Array.from(
      paragraph.querySelectorAll<HTMLElement>('[data-type="html-inline"]'),
    )
    const open = markers.find((marker) =>
      marker.textContent?.startsWith('<sub'),
    )!
    const close = markers.find((marker) => marker.textContent === '</sub>')!
    const range = document.createRange()
    range.setStartBefore(open)
    range.setEndAfter(close)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    root.focus({ preventScroll: true })
    document.dispatchEvent(new Event('selectionchange'))
  })
}

async function placeEmptyActionCaretByXtest(
  frame: ReturnType<typeof wf>,
  xtest: XtestInput,
): Promise<void> {
  await frame.locator('.vditor-ir p').filter({ hasText: 'Action H2O.' }).click()
  await xtest.key('Home')
  await keyTimes(xtest, 'Right', 8)
}

async function selectUnevenTableCellCharacterByXtest(
  frame: ReturnType<typeof wf>,
  xtest: XtestInput,
): Promise<void> {
  const cell = frame.locator('.vditor-ir td').filter({ hasText: 'H2O' })
  const position = await cell.evaluate((element) => {
    const text = element.firstChild
    if (!(text instanceof Text)) throw new Error('table cell text is missing')
    const range = document.createRange()
    range.setStart(text, 1)
    range.collapse(true)
    const caret = range.getBoundingClientRect()
    const box = element.getBoundingClientRect()
    return {
      x: caret.left - box.left + 1,
      y: caret.top - box.top + caret.height / 2,
    }
  })
  await cell.click({ position })
  await xtest.key('Shift+Right')
}

test('XTEST real-VS-Code HTML SUB toolbar preserves exact source, undo, save, and reopen', async ({
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
  const file = path.join(baseDir, 'html-subscript-editing.md')
  writeFileSync(file, INITIAL)
  await evaluateInVSCode(
    async (vscode, args: [string, string, string]) => {
      const config = vscode.workspace.getConfiguration('vmde')
      await config.update(
        'markdown.supSub',
        false,
        vscode.ConfigurationTarget.Global,
      )
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [file, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )

  let frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { message: 'HTML SUB XTEST readiness' },
  )
  const xtest = await createXtestInput(electronApp, workbox)
  expect(xtest.client.visible).toBe(true)
  expect(xtest.client.xid).toMatch(/^0x[\da-f]+$/i)

  // The iframe click establishes the webview's native input focus. XTEST then types through the
  // verified workbench X11 client, proving an OS-input edit reaches the host TextDocument.
  await frame
    .locator('.vditor-ir p')
    .filter({ hasText: 'XTEST target.' })
    .click()
  await xtest.type('OS')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toContain('XTEST target.OS')

  const subscript = frame.locator('.vditor-toolbar [data-type="subscript"]')
  await selectActionCharacterByXtest(frame, xtest)
  await expect(subscript).toBeEnabled()
  await subscript.click()
  const direction = await frame.locator('body').evaluate(() => {
    const selection = getSelection()!
    return {
      text: selection.toString(),
      backward: (() => {
        const anchor = document.createRange()
        anchor.setStart(selection.anchorNode!, selection.anchorOffset)
        anchor.collapse(true)
        const focus = document.createRange()
        focus.setStart(selection.focusNode!, selection.focusOffset)
        focus.collapse(true)
        return anchor.compareBoundaryPoints(Range.START_TO_START, focus) > 0
      })(),
    }
  })
  expect(direction).toEqual({ text: '2', backward: true })
  const wrapped = INITIAL.replace(
    'Action H2O.',
    'Action H<sub>2</sub>O.',
  ).replace('XTEST target.', 'XTEST target.OS')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(host(wrapped))

  await xtest.key('ctrl+z')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(host(INITIAL.replace('XTEST target.', 'XTEST target.OS')))
  await xtest.key('ctrl+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(host(wrapped))

  const actionPresentation = frame
    .locator('sub[data-vmde-html-subscript="1"]')
    .filter({ hasText: '2' })
    .last()
  await actionPresentation.click()
  await expect(
    frame.locator('.vditor-ir p').filter({ hasText: 'Action H' }),
  ).toBeVisible()
  await selectActionWrapper(frame)
  await subscript.click()
  const unwrapped = INITIAL.replace('XTEST target.', 'XTEST target.OS')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(host(unwrapped))

  await placeEmptyActionCaretByXtest(frame, xtest)
  expect(
    await frame.locator('body').evaluate(() => getSelection()?.isCollapsed),
  ).toBe(true)
  await expect(subscript).toBeEnabled()
  await subscript.click()
  const inserted = unwrapped.replace('Action H2O.', 'Action H<sub></sub>2O.')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(host(inserted))
  await xtest.type('x')
  const insertedCharacter = inserted.replace('<sub></sub>', '<sub>x</sub>')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(host(insertedCharacter))

  await selectUnevenTableCellCharacterByXtest(frame, xtest)
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => ({
        text: getSelection()?.toString(),
        enabled: !(
          document.querySelector(
            '[data-type="subscript"]',
          ) as HTMLButtonElement | null
        )?.disabled,
      })),
    )
    .toEqual({ text: '2', enabled: true })
  await subscript.click()
  const tableWrapped = insertedCharacter.replace(
    '|  keep  | H2O     |',
    '|  keep  | H<sub>2</sub>O     |',
  )
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(host(tableWrapped))
  await xtest.key('ctrl+z')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(host(insertedCharacter))
  await xtest.key('ctrl+y')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(host(tableWrapped))

  await evaluateInVSCode(async (vscode) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update('markdown.supSub', true, vscode.ConfigurationTarget.Global)
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(tableWrapped)
  frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
  )
  expect(await docText(evaluateInVSCode, file)).toBe(host(tableWrapped))
  await expect(
    frame.locator('.vditor-ir').filter({ hasText: 'Tilde #~stay~#.' }),
  ).toBeVisible()
})

test('XTEST narrow More menu activates Subscript by OS keyboard', async ({
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
  const file = path.join(baseDir, 'html-subscript-more.md')
  writeFileSync(file, 'Keyboard H2O.\r\n')
  await evaluateInVSCode(
    async (vscode, args: [string, string, string]) => {
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
      await vscode.commands.executeCommand('workbench.view.explorer')
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
    },
    [file, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )
  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
  )
  const subscript = frame.locator(
    '.vmde-toolbar-more [data-vmde-overflow="true"] [data-type="subscript"]',
  )
  let layout: {
    viewport: number
    webview: number
    toolbar: number
    overflow: string[]
  } | null = null
  const layouts: {
    viewport: number
    webview: number
    toolbar: number
    overflow: string[]
  }[] = []
  for (const width of [600, 520, 480, 440, 400]) {
    await workbox.setViewportSize({ width, height: 800 })
    await expect
      .poll(() =>
        frame
          .locator('.vditor-toolbar')
          .evaluate((toolbar) => toolbar.clientWidth),
      )
      .toBeGreaterThan(0)
    await frame
      .locator('body')
      .evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      )
    const candidate = await frame.locator('.vditor-toolbar').evaluate(
      (toolbar, viewport) => ({
        viewport,
        webview: document.documentElement.clientWidth,
        toolbar: toolbar.clientWidth,
        overflow: Array.from(
          toolbar.querySelectorAll<HTMLElement>(
            '[data-vmde-overflow="true"] > [data-type]',
          ),
        ).map((item) => item.dataset.type ?? ''),
      }),
      width,
    )
    layouts.push(candidate)
    if (candidate.webview <= 0) break
    if (candidate.overflow.includes('subscript')) {
      layout = candidate
      break
    }
  }
  if (!layout) console.log('TASK-553 More layout', layouts)
  expect(
    layout,
    'no positive-width viewport overflowed Subscript',
  ).not.toBeNull()
  await expect(subscript).toHaveCount(1)
  const xtest = await createXtestInput(electronApp, workbox)
  await frame
    .locator('.vditor-ir p')
    .filter({ hasText: 'Keyboard H2O.' })
    .click()
  await xtest.key('Home')
  await keyTimes(xtest, 'Right', 10)
  await xtest.key('Shift+Right')
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => getSelection()?.toString()),
    )
    .toBe('2')
  await expect(subscript).toBeEnabled()
  await xtest.key('Escape')
  await xtest.key('Tab')
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const toolbar = document.querySelector('.vditor-toolbar')
        const active = document.activeElement as HTMLElement | null
        return Boolean(toolbar?.contains(active) && active?.dataset.type)
      }),
    )
    .toBe(true)
  const arrowsToMore = await frame.locator('body').evaluate(() => {
    const toolbar = document.querySelector('.vditor-toolbar')!
    const items = Array.from(
      toolbar.querySelectorAll<HTMLElement>(
        ':scope .vditor-toolbar__item > [data-type]',
      ),
    ).filter(
      (item) =>
        item.closest('.vditor-hint') === null &&
        getComputedStyle(item).display !== 'none',
    )
    const from = items.indexOf(document.activeElement as HTMLElement)
    const to = items.findIndex((item) => item.dataset.type === 'more')
    if (from < 0 || to < 0) throw new Error('More is not in the roving toolbar')
    return (to - from + items.length) % items.length
  })
  await keyTimes(xtest, 'Right', arrowsToMore)
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(
          () => (document.activeElement as HTMLElement | null)?.dataset.type,
        ),
    )
    .toBe('more')
  await xtest.key('Return')
  await expect(frame.locator('.vmde-toolbar-more > .vditor-hint')).toBeVisible()
  await xtest.key('Tab')
  await frame.locator('body').evaluate(() => {
    const inner = (
      window as unknown as {
        vditor: {
          vditor: { undo?: { addToUndoStack?: (value: unknown) => void } }
        }
      }
    ).vditor.vditor
    inner.undo?.addToUndoStack?.(inner)
  })
  await expect(frame.locator('.vmde-toolbar-more > .vditor-hint')).toBeVisible()
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() =>
          Boolean(
            document
              .querySelector('.vditor-toolbar')
              ?.contains(document.activeElement),
          ),
        ),
    )
    .toBe(true)
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(host('Keyboard H2O.\r\n'))
  await xtest.key('Escape')
  await expect(frame.locator('.vmde-toolbar-more > .vditor-hint')).toBeHidden()
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(
          () =>
            document.activeElement === (window as any).vditor.vditor.ir.element,
        ),
    )
    .toBe(true)
  await frame
    .locator('.vditor-ir p')
    .filter({ hasText: 'Keyboard H2O.' })
    .click()
  await xtest.key('Home')
  await keyTimes(xtest, 'Right', 10)
  await xtest.key('Shift+Right')
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => getSelection()?.toString()),
    )
    .toBe('2')
  await xtest.key('Escape')
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => getSelection()?.toString()),
    )
    .toBe('Keyboard H2')
  await xtest.key('Tab')
  const repeatArrowsToMore = await frame.locator('body').evaluate(() => {
    const toolbar = document.querySelector('.vditor-toolbar')!
    const items = Array.from(
      toolbar.querySelectorAll<HTMLElement>(
        ':scope .vditor-toolbar__item > [data-type]',
      ),
    ).filter(
      (item) =>
        item.closest('.vditor-hint') === null &&
        getComputedStyle(item).display !== 'none',
    )
    const from = items.indexOf(document.activeElement as HTMLElement)
    const to = items.findIndex((item) => item.dataset.type === 'more')
    if (from < 0 || to < 0) throw new Error('More is not in the roving toolbar')
    return (to - from + items.length) % items.length
  })
  await keyTimes(xtest, 'Right', repeatArrowsToMore)
  await xtest.key('Return')
  await expect(frame.locator('.vmde-toolbar-more > .vditor-hint')).toBeVisible()
  await xtest.key('Tab')
  const arrowsToSubscript = await frame.locator('body').evaluate(() => {
    const panel = document.querySelector('.vmde-toolbar-more > .vditor-hint')!
    const items = Array.from(
      panel.querySelectorAll<HTMLElement>(
        '[data-vmde-overflow="true"] [data-type]',
      ),
    )
    const from = items.indexOf(document.activeElement as HTMLElement)
    const to = items.findIndex((item) => item.dataset.type === 'subscript')
    if (from < 0 || to < 0)
      throw new Error('Subscript is not in the More keyboard menu')
    return (to - from + items.length) % items.length
  })
  await keyTimes(xtest, 'Down', arrowsToSubscript)
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(
          () => (document.activeElement as HTMLElement | null)?.dataset.type,
        ),
    )
    .toBe('subscript')
  await xtest.key('Return')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(host('Keyboard H<sub>2</sub>O.\r\n'))
})
