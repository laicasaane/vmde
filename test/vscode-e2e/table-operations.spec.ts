import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'table-nav.md')

async function selectRectangle(
  frame: ReturnType<typeof wf>,
  selector: '.vditor-ir' | '.vditor-wysiwyg',
) {
  return frame.locator('body').evaluate((_body, _surface) => {
    const v = (window as any).vditor
    const root = v.vditor[v.getCurrentMode()].element as HTMLElement
    const cells = root.querySelectorAll<HTMLTableCellElement>('td')
    const range = document.createRange()
    range.selectNodeContents(cells[0])
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const before = v.getValue()
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    const selected = root.querySelectorAll('.vmde-cell-selected').length
    const after = v.getValue()
    const clipboard = new DataTransfer()
    root.dispatchEvent(
      new ClipboardEvent('copy', {
        clipboardData: clipboard,
        bubbles: true,
        cancelable: true,
      }),
    )
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    )
    return {
      before,
      after,
      selected,
      remaining: root.querySelectorAll('.vmde-cell-selected').length,
      plain: clipboard.getData('text/plain'),
      markdown: clipboard.getData('text/markdown'),
    }
  }, selector)
}

test('cell rectangles are source-invisible in IR and WYSIWYG', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [FIXTURE] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir td').first().waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      timeout: 60_000,
      message: 'IR mode did not become ready',
    },
  )
  const ir = await selectRectangle(frame, '.vditor-ir')
  expect(ir.selected).toBe(2)
  expect(ir.after).toBe(ir.before)
  expect(ir.remaining).toBe(0)
  expect(ir.plain).toBe('r0a\tr0b')
  expect(ir.markdown).toBe('| r0a | r0b |\n|---|---|')

  await frame.locator('body').evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
    timeout: 60_000,
    message: 'WYSIWYG mode did not become ready',
  })
  await frame.locator('.vditor-wysiwyg td').first().waitFor({ timeout: 30_000 })
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const root = (window as any).vditor.vditor.wysiwyg
          .element as HTMLElement
        const cell = root.querySelector('td')!
        const range = document.createRange()
        range.selectNodeContents(cell)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        return Boolean(document.querySelector('#vmde-table-moves'))
      }),
    )
    .toBe(true)
  const wysiwyg = await selectRectangle(frame, '.vditor-wysiwyg')
  expect(wysiwyg.selected).toBe(2)
  expect(wysiwyg.after).toBe(wysiwyg.before)
  expect(wysiwyg.remaining).toBe(0)
  expect(wysiwyg.plain).toBe('r0a\tr0b')
  expect(wysiwyg.markdown).toBe('| r0a  | r0b  |\n|---|---|')
})

test('IR move preserves exact noncanonical source through one undo, redo, save, and reopen', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'table-operations-exact.md')
  const initial = [
    'before',
    '',
    '|  Left  | Right   |',
    '| :--- | ---: |',
    '| *one* | `two` |',
    '',
    'between',
    '',
    '|  Left  | Right   |',
    '| :--- | ---: |',
    '| *one* | `two` |',
    '',
    'after',
    '',
  ].join('\r\n')
  const moved = initial.replace(
    '|  Left  | Right   |\r\n| :--- | ---: |\r\n| *one* | `two` |',
    '| Right   |  Left  |\r\n| ---: | :--- |\r\n| `two` | *one* |',
  )
  writeFileSync(file, initial)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
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
  await frame.locator('.vditor-ir td').first().waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(frame, (state) => state.mode === 'ir', {
    timeout: 60_000,
    message: 'exact table transaction did not become ready',
  })
  await frame.locator('.vditor-ir td').nth(1).click()
  await frame.locator('#fix-table-ir-wrapper .vditor-panel').hover()
  await frame
    .locator('#fix-table-ir-wrapper [data-type="moveColumnLeft"]')
    .click()
  await expect
    .poll(async () => {
      return await evaluateInVSCode(
        async (vscode: typeof import('vscode'), args: string[]) =>
          vscode.workspace.textDocuments
            .find((document) => document.uri.fsPath === args[0])
            ?.getText(),
        [file] as [string],
      )
    })
    .toBe(moved)
  expect(
    await frame.locator('body').evaluate(() => {
      const node = getSelection()?.anchorNode
      const cell = (
        node instanceof Element ? node : node?.parentElement
      )?.closest('td,th')
      return cell?.textContent?.trim()
    }),
  ).toBe('`two`')
  // This is a scripted webview regression check, not OS-input evidence (Task 222's XTEST gate is
  // separately blocked). It proves the transaction remains a single native undo entry.
  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await expect
    .poll(async () => {
      return await evaluateInVSCode(
        async (vscode: typeof import('vscode'), args: string[]) =>
          vscode.workspace.textDocuments
            .find((document) => document.uri.fsPath === args[0])
            ?.getText(),
        [file] as [string],
      )
    })
    .toBe(initial)
  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'y',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await expect
    .poll(async () => {
      return await evaluateInVSCode(
        async (vscode: typeof import('vscode'), args: string[]) =>
          vscode.workspace.textDocuments
            .find((document) => document.uri.fsPath === args[0])
            ?.getText(),
        [file] as [string],
      )
    })
    .toBe(moved)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(moved)
  await evaluateInVSCode(
    async (vscode, args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  frame = wf(workbox)
  await waitForE2EReadiness(frame, (state) => state.mode === 'ir', {
    timeout: 60_000,
    message: 'reopened exact table transaction did not become ready',
  })
  expect(await readFileSync(file, 'utf8')).toBe(moved)
})

test('WYSIWYG ordinary range control inserts once, undoes once, and retires for IME', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'table-range-wysiwyg.md')
  writeFileSync(file, '| a | b |\n| --- | --- |\n| one | two |\n')
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
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
  await frame.locator('.vditor-ir td').first().waitFor({ timeout: 90_000 })
  await frame.locator('body').evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
    timeout: 60_000,
    message: 'WYSIWYG range transaction did not become ready',
  })
  const before = await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.wysiwyg.element as HTMLElement
    const cells = root.querySelectorAll<HTMLTableCellElement>('td')
    const range = document.createRange()
    range.selectNodeContents(cells[0])
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    document.dispatchEvent(new Event('selectionchange'))
    return root.querySelectorAll('.vmde-cell-selected').length
  })
  expect(before).toBe(2)
  await frame
    .locator('.vditor-wysiwyg > .vditor-panel button[data-type="insertColumn"]')
    .nth(1)
    .click()
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const root = (window as any).vditor.vditor.wysiwyg
          .element as HTMLElement
        return root.querySelector('table')!.rows[0].cells.length
      }),
    )
    .toBe(4)
  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.wysiwyg.element as HTMLElement
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const root = (window as any).vditor.vditor.wysiwyg
          .element as HTMLElement
        return root.querySelector('table')!.rows[0].cells.length
      }),
    )
    .toBe(2)
  const ime = await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.wysiwyg.element as HTMLElement
    const cells = root.querySelectorAll<HTMLTableCellElement>('td')
    const range = document.createRange()
    range.selectNodeContents(cells[0])
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    const armed = root.querySelectorAll('.vmde-cell-selected').length
    root.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    )
    return { armed, after: root.querySelectorAll('.vmde-cell-selected').length }
  })
  expect(ime).toEqual({ armed: 2, after: 0 })
})
