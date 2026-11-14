import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const INITIAL = `# Ordered lists

1. alpha
2. beta

Bridge paragraph stays byte-identical.

1. first
2. second
3. third
`

const MOVED = `# Ordered lists

1. beta

Bridge paragraph stays byte-identical.

1. alpha
2. first
3. second
4. third
`

test('drag-moving an ordered item renumbers the local roots as one undoable edit', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'list-auto-renumber.md')
  writeFileSync(file, INITIAL)
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

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'list auto-renumber readiness' },
  )
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => (window as any).vditor.getValue() as string),
    )
    .toBe(INITIAL)
  await frame.locator('.vditor-ir').click({ position: { x: 20, y: 20 } })

  const before = await frame.locator('body').evaluate(() => {
    const outer = (window as any).vditor
    const inner = outer.vditor
    const editor = inner.ir.element as HTMLElement
    let spins = 0
    let inputs = 0
    const originalSpin = inner.lute.SpinVditorIRDOM.bind(inner.lute)
    const originalInput = inner.options.input
    inner.lute.SpinVditorIRDOM = (html: string) => {
      spins++
      return originalSpin(html)
    }
    inner.options.input = (...args: unknown[]) => {
      inputs++
      return originalInput?.(...args)
    }
    ;(window as any).__task284 = {
      counts: () => ({ spins, inputs }),
    }

    const items = Array.from(editor.querySelectorAll<HTMLElement>('li'))
    const source = items.find((item) => item.textContent?.includes('alpha'))!
    const target = items.find((item) => item.textContent?.includes('first'))!
    source.scrollIntoView({ block: 'center' })
    const range = document.createRange()
    range.selectNodeContents(source)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus({ preventScroll: true })
    const scrollTop = editor.scrollTop
    const transfer = new DataTransfer()
    source.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }),
    )
    target.dispatchEvent(
      new DragEvent('drop', { bubbles: true, dataTransfer: transfer }),
    )
    target.parentElement?.insertBefore(source, target)
    return new Promise<{ scrollTop: number; undoLength: number }>((resolve) =>
      requestAnimationFrame(() => {
        const movedText = source.firstChild as Text
        const movedRange = document.createRange()
        movedRange.setStart(movedText, 2)
        movedRange.collapse(true)
        selection.removeAllRanges()
        selection.addRange(movedRange)
        resolve({
          scrollTop,
          undoLength: ((globalThis as any).__vmdeUnitHistory?.holds(inner)
            ? (globalThis as any).__vmdeUnitHistory.depth(inner).undo
            : inner.undo.ir.undoStack.length) as number,
        })
      }),
    )
  })

  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(MOVED)
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => (window as any).__task284.counts()),
    )
    .toEqual({ spins: 2, inputs: 1 })
  const state = await frame.locator('body').evaluate(() => {
    const outer = (window as any).vditor
    const inner = outer.vditor
    const editor = inner.ir.element as HTMLElement
    const selection = getSelection()!
    const anchorElement =
      selection.anchorNode?.nodeType === Node.ELEMENT_NODE
        ? (selection.anchorNode as Element)
        : selection.anchorNode?.parentElement
    return {
      anchorText: selection.anchorNode?.textContent ?? '',
      itemText: anchorElement?.closest('li')?.textContent ?? '',
      anchorOffset: selection.anchorOffset,
      scrollTop: editor.scrollTop,
      bridgeCount: (outer.getValue() as string).split(
        'Bridge paragraph stays byte-identical.',
      ).length,
      undoLength: ((globalThis as any).__vmdeUnitHistory?.holds(inner)
        ? (globalThis as any).__vmdeUnitHistory.depth(inner).undo
        : inner.undo.ir.undoStack.length) as number,
    }
  })
  expect(state.anchorText).toContain('alpha')
  expect(state.itemText).toContain('alpha')
  expect(state.anchorOffset).toBe(0)
  expect(state.scrollTop).toBe(before.scrollTop)
  expect(state.bridgeCount).toBe(2)
  await expect
    .poll(async () => {
      return frame.locator('body').evaluate(() => {
        const inner = (window as any).vditor.vditor
        return (
          (globalThis as any).__vmdeUnitHistory?.holds(inner)
            ? (globalThis as any).__vmdeUnitHistory.depth(inner).undo
            : inner.undo.ir.undoStack.length
        ) as number
      })
    })
    .toBeGreaterThan(before.undoLength)

  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INITIAL)
  await workbox.keyboard.press('Control+Shift+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(MOVED)

  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(MOVED)
})
