import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  settle,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

type Evaluate = Parameters<typeof docText>[0]

/** A caret target in the Source editor text: `delta` characters after the first `needle`. */
interface CaretTarget {
  needle: string
  delta: number
}

/**
 * Opens `file` in the custom editor (IR first), switches to Source, and returns the frame. After the
 * switch the Source text is Lute's serialization, so a table shows padded cells while the host text
 * stays raw.
 */
async function openInSource(
  evaluateInVSCode: Evaluate,
  workbox: import('@playwright/test').Page,
  file: string,
) {
  // An earlier case's editor can stay open in the same VS Code, and the host command would then
  // reach the wrong webview; start from no open editor.
  await evaluateInVSCode(
    async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    },
    [file] as [string],
  )
  await evaluateInVSCode(
    async (vscode, args: string[]) => {
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
  await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
  await settle(frame, 1500)
  await frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    document.querySelector<HTMLButtonElement>('button[data-mode="sv"]')?.click()
  })
  await waitForE2EReadiness(frame, (state) => state.mode === 'sv', {
    message: 'SV did not become ready',
  })
  await frame.locator('.vditor-sv').click()
  return frame
}

/** Places the Source caret at `target` and has the table-format command retain it (the host command
 * moves focus out of the webview first). Returns the placed offset and the expected one. */
const placeSourceCaret = (_body: Element, target: CaretTarget) => {
  const root = (window as any).vditor.vditor.sv.element as HTMLElement
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const expected =
    (root.textContent ?? '').indexOf(target.needle) + target.delta
  let remaining = expected
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    if (remaining <= node.data.length) {
      const range = document.createRange()
      range.setStart(node, remaining)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      if (!(window as any).__vmdeCaptureTableFormatSelectionForTest?.())
        throw new Error(
          'SV table source selection was not captured before host focus',
        )
      const before = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let rootOffset = 0
      for (
        let text = before.nextNode() as Text | null;
        text;
        text = before.nextNode() as Text | null
      ) {
        if (text === selection.anchorNode) {
          rootOffset += selection.anchorOffset
          break
        }
        rootOffset += text.data.length
      }
      return { rootOffset, expected }
    }
    remaining -= node.data.length
  }
  throw new Error('SV table caret target missing')
}

/** The Source caret as an offset into the editor text, and the editor text itself. */
const readSourceCaret = () => {
  const root = (window as any).vditor.vditor.sv.element as HTMLElement
  const selection = getSelection()
  if (!selection?.rangeCount || !selection.anchorNode)
    throw new Error('formatted SV selection is missing')
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let offset = 0
  for (
    let text = walker.nextNode() as Text | null;
    text;
    text = walker.nextNode() as Text | null
  ) {
    if (text === selection.anchorNode) {
      offset += selection.anchorOffset
      break
    }
    offset += text.data.length
  }
  return { offset, text: root.textContent ?? '' }
}

async function saveDocument(evaluateInVSCode: Evaluate, file: string) {
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === args[0],
      )
      if (!document || !(await document.save()))
        throw new Error('formatted source document did not save')
    },
    [file] as [string],
  )
}

test('Format table command keeps exact CRLF source through undo, redo, save, and reopen in SV', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'table-format.md')
  const before = [
    'before',
    '',
    '|a| longer |',
    '|:-|---:|',
    '|x\\|y|全角|',
    '',
    'after',
    '',
  ].join('\r\n')
  const after = [
    'before',
    '',
    '| a   | longer |',
    '| :-- | -----: |',
    '| x\\|y |   全角 |',
    '',
    'after',
    '',
  ].join('\r\n')
  writeFileSync(file, before)
  let frame = await openInSource(evaluateInVSCode, workbox, file)
  const initialSelection = await frame
    .locator('body')
    .evaluate(placeSourceCaret, { needle: 'longer', delta: 2 })
  expect(initialSelection.rootOffset).toBe(initialSelection.expected)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.formatTable')
  })
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
  const restoredCaret = await frame.locator('body').evaluate(readSourceCaret)
  const expectedCaret = restoredCaret.text.indexOf('longer') + 2
  expect(restoredCaret.offset).toBe(expectedCaret)
  // Task 580 CP2-3 moved Undo/Redo to VS Code's keys (`vmde.format.undo` / `redo`), so a synthetic
  // webview Ctrl+Z/Y no longer undoes; press the keys through the workbench instead.
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(before)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
  await saveDocument(evaluateInVSCode, file)
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(after)
  frame = await reopenVmdeFixture(
    evaluateInVSCode,
    workbox,
    file,
    60_000,
    // The editor reopens in the mode it was saved from (markdown-editor-provider.ts), here SV.
    '.vditor-sv',
  )
  expect(await readFileSync(file, 'utf8')).toBe(after)
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
})

// Task 681: after a switch to Source the editor shows Lute's padded table while the host keeps the
// raw bytes. A caret in a cell's padding has no exact image, so it used to decline silently; it must
// snap to the nearest proven offset in its own cell and format the table.
const PADDED_TABLE = [
  '| a         | longer |',
  '| --------- | ------ |',
  '| wide text |        |',
]
const PADDING_CASES: Array<{
  name: string
  caret: CaretTarget
  /** Where the caret may land once the table is formatted: `delta` range after the first `needle`. */
  landing: { needle: string; min: number; max: number }
}> = [
  {
    name: 'left padding',
    caret: { needle: '| a ', delta: 2 },
    landing: { needle: '| a ', min: 2, max: 2 },
  },
  {
    name: 'right padding',
    caret: { needle: '| a ', delta: 7 },
    landing: { needle: '| a ', min: 3, max: 3 },
  },
  {
    name: 'an empty cell',
    caret: { needle: '| wide text |', delta: 17 },
    landing: { needle: '| wide text |', min: 13, max: 21 },
  },
]

for (const padding of PADDING_CASES) {
  test(`Format table formats a switched Source table with the caret in ${padding.name}, through one undo and save`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const file = path.join(baseDir, 'table-format-padding.md')
    const before = [
      'before',
      '',
      '|a|longer|',
      '|-|-|',
      '|wide text||',
      '',
      'after',
      '',
    ].join('\r\n')
    const after = ['before', '', ...PADDED_TABLE, '', 'after', ''].join('\r\n')
    writeFileSync(file, before)
    const frame = await openInSource(evaluateInVSCode, workbox, file)
    // The switch itself padded the editor text; the host bytes are still raw.
    const shown = await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.vditor.sv.element.textContent)
    expect(shown).toContain(PADDED_TABLE.join('\n'))
    expect(await docText(evaluateInVSCode, file)).toBe(before)
    const placed = await frame
      .locator('body')
      .evaluate(placeSourceCaret, padding.caret)
    expect(placed.rootOffset).toBe(placed.expected)
    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('vmde.formatTable')
    })
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
    // The caret stays in the cell it was in.
    const caret = await frame.locator('body').evaluate(readSourceCaret)
    const landing = caret.text.indexOf(padding.landing.needle)
    expect(caret.offset).toBeGreaterThanOrEqual(landing + padding.landing.min)
    expect(caret.offset).toBeLessThanOrEqual(landing + padding.landing.max)
    // One Undo restores the typed state: the raw host bytes.
    await workbox.keyboard.press('Control+z')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(before)
    await workbox.keyboard.press('Control+y')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
    await saveDocument(evaluateInVSCode, file)
    await expect.poll(() => readFileSync(file, 'utf8')).toBe(after)
  })
}
