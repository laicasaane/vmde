import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update(
        'editor.modifierClickLinks',
        undefined,
        vscode.ConfigurationTarget.Global,
      )
  })
})

async function openMarkdown(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: (fn: unknown, args: [string]) => Promise<unknown>,
  file: string,
) {
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
  )
  return frame
}

test('real IR pointer activation opens a Markdown link for Ctrl+click and click policy', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  const file = path.join(baseDir, 'ir-link-pointer.md')
  const target = path.join(baseDir, 'target.md')
  writeFileSync(file, '# Link\n\n[Open target](target.md)\n')
  writeFileSync(target, '# Target\n')
  const frame = await openMarkdown(workbox, evaluateInVSCode, file)
  const label = frame.locator('.vditor-ir [data-type="a"] .vditor-ir__link')
  const activeEditorIs = (expected: string) =>
    evaluateInVSCode(
      async (vscode, args: [string]) => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as
          | { uri?: { fsPath?: string } }
          | undefined
        return input?.uri?.fsPath === args[0]
      },
      [expected],
    ) as Promise<boolean>
  await label.click({ modifiers: ['Control'] })
  await expect.poll(() => activeEditorIs(target)).toBe(true)

  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
  })
  await expect.poll(() => activeEditorIs(file)).toBe(true)
  await expect(label).toBeVisible()
  await evaluateInVSCode(async (vscode) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update(
        'editor.modifierClickLinks',
        false,
        vscode.ConfigurationTarget.Global,
      )
  })
  await expect
    .poll(() =>
      label.evaluate(() =>
        (window as any).__vmdeShouldOpenLink?.(
          new MouseEvent('click', { cancelable: true }),
        ),
      ),
    )
    .toBe(true)
  await label.click()
  await expect.poll(() => activeEditorIs(target)).toBe(true)
})

test('IR code source keeps native left/right/up/down caret navigation', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  const file = path.join(baseDir, 'ir-code-arrows.md')
  writeFileSync(
    file,
    '# Code\n\nbefore\n\n```ts\nalpha\nbeta\ngamma\n```\n\nafter\n',
  )
  const frame = await openMarkdown(workbox, evaluateInVSCode, file)
  await frame.locator('.vditor-ir__preview code.language-ts').click()
  const source = frame.locator('.vditor-ir__marker--pre code.language-ts')
  await expect(source).toBeVisible()
  await source.click()

  const placeIn = (needle: string, offset: number) =>
    source.evaluate(
      (code, args: [string, number]) => {
        const [text, at] = args
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = (node.textContent ?? '').indexOf(text)
          if (index < 0) continue
          const editor = code.closest<HTMLElement>('.vditor-reset')!
          editor.focus({ preventScroll: true })
          const range = document.createRange()
          range.setStart(node, index + at)
          range.collapse(true)
          const selection = getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
          ;(window as any).__vmdeRequestCaret?.({
            node: range.startContainer,
            offset: range.startOffset,
          })
          return
        }
        throw new Error(`${text} not found in code source`)
      },
      [needle, offset] as [string, number],
    )
  const caret = () =>
    source.evaluate((code) => {
      const selection = getSelection()
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null
      if (!range || !code.contains(range.startContainer)) return null
      const prefix = range.cloneRange()
      prefix.selectNodeContents(code)
      prefix.setEnd(range.startContainer, range.startOffset)
      return prefix.toString().length
    })

  await placeIn('beta', 2)
  const start = await caret()
  expect(start).not.toBeNull()
  await workbox.keyboard.press('ArrowRight')
  await expect.poll(caret).toBe((start ?? 0) + 1)
  await workbox.keyboard.press('ArrowLeft')
  await expect.poll(caret).toBe(start)
  await workbox.keyboard.press('ArrowDown')
  await expect.poll(caret).toBeGreaterThan((start ?? 0) + 2)
  await workbox.keyboard.press('ArrowUp')
  await expect.poll(caret).toBe(start)
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toBe('# Code\n\nbefore\n\n```ts\nalpha\nbeta\ngamma\n```\n\nafter\n')
})

test('double Enter after the final unordered and ordered item exits to a writable paragraph', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  const file = path.join(baseDir, 'ir-list-exit.md')
  writeFileSync(
    file,
    '# Lists\n\n- unordered one\n- unordered last\n\n1. ordered one\n2. ordered last\n',
  )
  const frame = await openMarkdown(workbox, evaluateInVSCode, file)

  const placeAtEnd = async (needle: string) => {
    const exactText = new RegExp(
      `^${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    )
    const item = frame
      .locator('.vditor-ir li')
      .filter({ hasText: exactText })
      .first()
    await item.click()
    await item.evaluate((li, target) => {
      const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(target)
        if (index < 0) continue
        ;(li.closest('.vditor-ir') as HTMLElement).focus({
          preventScroll: true,
        })
        const range = document.createRange()
        range.setStart(node, index + target.length)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        return
      }
      throw new Error(`${target} not found in list item`)
    }, needle)
  }
  const exitList = async (needle: string, inserted: string) => {
    await placeAtEnd(needle)
    await workbox.keyboard.press('Enter')
    await expect
      .poll(() =>
        frame.locator('body').evaluate(() => {
          const anchor = getSelection()?.anchorNode
          return anchor instanceof Element
            ? (anchor.closest('li')?.textContent ?? null)
            : (anchor?.parentElement?.closest('li')?.textContent ?? null)
        }),
      )
      .toBe('')
    await workbox.keyboard.press('Enter')
    await expect
      .poll(() =>
        frame.locator('body').evaluate(() => {
          const selection = getSelection()
          const anchor = selection?.anchorNode
          const host =
            anchor instanceof Element ? anchor : anchor?.parentElement
          const paragraph = host?.closest('p')
          return Boolean(
            paragraph?.parentElement?.classList.contains('vditor-reset'),
          )
        }),
      )
      .toBe(true)
    await workbox.keyboard.insertText(inserted)
    await expect.poll(() => docText(evaluateInVSCode, file)).toContain(inserted)
  }

  await exitList('unordered last', 'after unordered')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toContain('- unordered last\n\nafter unordered')
  await exitList('ordered last', 'after ordered')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toContain('2. ordered last\n\nafter ordered')
})
