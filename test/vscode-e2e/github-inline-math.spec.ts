import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import { docText, settle, wf } from './webview-helpers'
import type { XtestInput } from './helpers/xtest-input'

const source = [
  'ordinary $E=mc^2$ and `literal code`.',
  '',
  'Select target here and insert empty here.',
  '',
].join('\r\n')

const expectedSource = [
  'ordinary $E=mc^2$ and `literal code`.',
  '',
  'Select $`q`$ here and insert $`z`$empty here.',
  '',
].join('\r\n')

const expectedSelectedSource = [
  'ordinary $E=mc^2$ and `literal code`.',
  '',
  'Select $`q`$ here and insert empty here.',
  '',
].join('\r\n')

const expectedPendingSelectedSource = [
  'ordinary $E=mc^2$ and `literal code`.',
  '',
  'Select $`target`$ here and insert empty here.',
  '',
].join('\r\n')

async function openMathDocument(
  evaluateInVSCode: (fn: unknown, args: string[]) => Promise<unknown>,
  frame: ReturnType<typeof wf>,
  file: string,
) {
  writeFileSync(file, source)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file],
  )
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await settle(frame, 900)
}

async function selectText(
  frame: ReturnType<typeof wf>,
  needle: string,
  backward = false,
  surface = '.vditor-ir',
) {
  await frame
    .locator(surface)
    .first()
    .click({ position: { x: 8, y: 8 } })
  await frame.locator('body').evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: resolves a directional text selection in each live Vditor editing surface.
    (_body, args) => {
      const { text, reverse, surface } = args as {
        text: string
        reverse: boolean
        surface: string
      }
      const root = document.querySelector(surface)
      if (!root) throw new Error(`missing ${surface}`)
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let next = walker.nextNode(); next; next = walker.nextNode()) {
        const node = next as Text
        const offset = node.data.indexOf(text)
        if (offset < 0) continue
        const selection = getSelection()
        if (!selection) throw new Error('no selection')
        selection.removeAllRanges()
        selection.setBaseAndExtent(
          node,
          reverse ? offset + text.length : offset,
          node,
          reverse ? offset : offset + text.length,
        )
        ;(node.parentElement as HTMLElement | null)?.focus()
        return
      }
      throw new Error(`missing ${text}`)
    },
    { text: needle, reverse: backward, surface },
  )
}

async function switchMode(
  frame: ReturnType<typeof wf>,
  mode: 'wysiwyg' | 'sv',
) {
  await frame.locator('body').evaluate((_body, nextMode) => {
    const inner = (window as unknown as { vditor: { vditor: any } }).vditor
      .vditor
    if (inner.currentMode === nextMode) return
    inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    document
      .querySelector<HTMLButtonElement>(`button[data-mode="${nextMode}"]`)
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
  }, mode)
  await frame.locator(`.vditor-${mode}`).first().waitFor({ timeout: 60_000 })
}

async function activateMath(frame: ReturnType<typeof wf>) {
  await frame.locator('[data-type="math"]').click()
  await frame.locator('[data-type="math-inline-github"]').click()
}

async function arrowsTo(
  frame: ReturnType<typeof wf>,
  target: string,
  menu = false,
): Promise<number> {
  return frame.locator('body').evaluate(
    (_body, args) => {
      const root = document.querySelector(
        args.menu ? '.vmde-toolbar-more > .vditor-hint' : '.vditor-toolbar',
      )
      if (!root) throw new Error('toolbar navigation root missing')
      const items = Array.from(
        root.querySelectorAll<HTMLElement>(
          args.menu
            ? '[data-vmde-overflow="true"] [data-type]'
            : ':scope .vditor-toolbar__item > [data-type]',
        ),
      ).filter((item) => getComputedStyle(item).display !== 'none')
      const from = items.indexOf(document.activeElement as HTMLElement)
      const to = items.findIndex((item) => item.dataset.type === args.target)
      if (from < 0 || to < 0) throw new Error(`cannot focus ${args.target}`)
      return (to - from + items.length) % items.length
    },
    { target, menu },
  )
}

async function keys(input: XtestInput, keysym: string, count: number) {
  for (let index = 0; index < count; index++) await input.key(keysym)
}

test('GitHub inline Math preserves CRLF source through selected and empty typing, undo/redo, Preview, and reopen', async ({
  electronApp,
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires the explicit XTEST runner',
  )
  test.setTimeout(150_000)
  const file = path.join(baseDir, 'github-inline-math.md')
  const frame = wf(workbox)
  await openMathDocument(evaluateInVSCode, frame, file)
  const xtest = await createXtestInput(electronApp, workbox)
  expect(xtest.client.visible).toBe(true)

  await selectText(frame, 'target', true)
  let mathOverflowed = false
  for (const width of [600, 520, 480, 440, 400]) {
    await workbox.setViewportSize({ width, height: 800 })
    mathOverflowed = await frame
      .locator('.vditor-toolbar')
      .evaluate((toolbar) =>
        Boolean(
          toolbar.querySelector(
            '[data-vmde-overflow="true"] > [data-type="math"]',
          ),
        ),
      )
    if (mathOverflowed) break
  }
  expect(mathOverflowed).toBe(true)
  await xtest.key('Escape')
  await xtest.key('Tab')
  await keys(xtest, 'Right', await arrowsTo(frame, 'more'))
  await xtest.key('Return')
  await expect(frame.locator('.vmde-toolbar-more > .vditor-hint')).toBeVisible()
  await xtest.key('Tab')
  await keys(xtest, 'Down', await arrowsTo(frame, 'math', true))
  await xtest.key('Return')
  await expect(frame.locator('[data-type="math-inline-github"]')).toBeVisible()
  await xtest.key('Tab')
  await xtest.key('Escape')
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => Boolean(document.activeElement?.closest('.vditor-ir'))),
    )
    .toBe(true)
  await xtest.key('Home')
  await keys(xtest, 'Right', 13)
  await keys(xtest, 'Shift+Left', 6)
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const selection = getSelection()
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null
        return {
          text: selection?.toString(),
          collapsed: range?.collapsed,
          backward:
            selection?.anchorNode === range?.endContainer &&
            selection?.anchorOffset === range?.endOffset,
        }
      }),
    )
    .toEqual({ text: 'target', collapsed: false, backward: true })
  await xtest.key('Escape')
  await xtest.key('Tab')
  await keys(xtest, 'Right', await arrowsTo(frame, 'more'))
  await xtest.key('Return')
  await xtest.key('Tab')
  await keys(xtest, 'Down', await arrowsTo(frame, 'math', true))
  await xtest.key('Return')
  await xtest.key('Tab')
  await xtest.key('Return')
  await settle(frame, 300)
  const direction = await frame.locator('body').evaluate(() => {
    const selection = getSelection()!
    const range = selection.getRangeAt(0)
    return {
      text: selection.toString(),
      collapsed: range.collapsed,
      backward:
        selection.anchorNode === range.endContainer &&
        selection.anchorOffset === range.endOffset,
    }
  })
  expect(direction).toEqual({
    text: 'target',
    collapsed: false,
    backward: true,
  })
  await xtest.type('q')
  await expect
    .poll(() => docText(evaluateInVSCode, file), { timeout: 20_000 })
    .toContain('$`q`$')

  await selectText(frame, 'empty')
  await frame.locator('body').evaluate(() => {
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    if (!selection || !range) throw new Error('missing empty selection')
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await workbox.setViewportSize({ width: 1280, height: 800 })
  await expect(frame.locator('[data-type="math"]')).toBeVisible()
  await activateMath(frame)
  await xtest.type('z')
  await expect
    .poll(() => docText(evaluateInVSCode, file), { timeout: 20_000 })
    .toContain('$`z`$empty')

  const changed = await docText(evaluateInVSCode, file)
  expect(changed).toBe(expectedSource)
  expect(changed).toContain('ordinary $E=mc^2$ and `literal code`.')
  expect(changed).toContain('\r\n')
  await xtest.key('ctrl+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).not.toBe(changed)
  await xtest.key('ctrl+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(changed)

  await frame.locator('[data-type="preview"]').click()
  const beforePreview = await docText(evaluateInVSCode, file)
  await expect(frame.locator('[data-type="math-inline-github"]')).toBeDisabled()
  await frame
    .locator('body')
    .evaluate(() =>
      document.dispatchEvent(new Event('vmde-insert-github-inline-math')),
    )
  await settle(frame, 300)
  expect(await docText(evaluateInVSCode, file)).toBe(beforePreview)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    },
    [file],
  )
  expect(readFileSync(file, 'utf8')).toBe(expectedSource)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file],
  )
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(expectedSource)
})

test('XTEST WYSIWYG GitHub inline Math preserves selected and empty source typing', async ({
  electronApp,
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires the explicit XTEST runner',
  )
  test.setTimeout(150_000)
  const file = path.join(baseDir, 'github-inline-math-wysiwyg.md')
  const frame = wf(workbox)
  await openMathDocument(evaluateInVSCode, frame, file)
  await switchMode(frame, 'wysiwyg')
  const xtest = await createXtestInput(electronApp, workbox)

  await selectText(frame, 'target', true, '.vditor-wysiwyg')
  await activateMath(frame)
  await xtest.type('q')
  await expect.poll(() => docText(evaluateInVSCode, file)).toContain('$`q`$')

  await selectText(frame, 'empty', false, '.vditor-wysiwyg')
  await frame.locator('body').evaluate(() => {
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    if (!selection || !range) throw new Error('missing empty selection')
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await activateMath(frame)
  await xtest.type('z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(expectedSource)
})

test('XTEST SV GitHub inline Math preserves selected and empty source typing', async ({
  electronApp,
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires the explicit XTEST runner',
  )
  test.setTimeout(150_000)
  const file = path.join(baseDir, 'github-inline-math-sv.md')
  const frame = wf(workbox)
  await openMathDocument(evaluateInVSCode, frame, file)
  await switchMode(frame, 'sv')
  const xtest = await createXtestInput(electronApp, workbox)

  await selectText(frame, 'target', true, '.vditor-sv')
  await activateMath(frame)
  // Source-mode toolbar dispatch completes after Vditor's native focus hand-off; wait for the
  // delimiter mutation before XTEST sends physical input, so the key cannot precede the action.
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(expectedPendingSelectedSource)
  await xtest.type('q')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe(expectedSelectedSource)

  await selectText(frame, 'empty', false, '.vditor-sv')
  await frame.locator('body').evaluate(() => {
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    if (!selection || !range) throw new Error('missing empty selection')
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await activateMath(frame)
  await xtest.type('z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(expectedSource)
})
