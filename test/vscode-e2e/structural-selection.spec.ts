import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

const INITIAL = [
  'alpha **bold scope** omega',
  '',
  '- first item',
  '  - nested item',
  '',
  '| A | B |',
  '| --- | --- |',
  '| cell one | cell two |',
  '',
  '```ts',
  'const fence = true',
  '```',
  '',
  'strikeword remains',
  '',
  'list target',
  '',
  'final paragraph',
].join('\n')

type VmdeFrame = ReturnType<typeof wf>

// Task 580 CP2-6 — Select All and Expand Selection are the contributed `vmde.selectAll` and
// `vmde.expandSelection` commands on VS Code's own Linux keys, so every key below goes through VS
// Code's keybinding service. Ctrl+E is free again (VS Code's Quick Open).
const SELECT_ALL = 'Control+a'
const EXPAND = 'Shift+Alt+ArrowRight'

const selectionText = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => getSelection()?.toString() ?? '')

const wholeEditorSelected = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    return Boolean(
      range &&
        range.startContainer === editor &&
        range.startOffset === 0 &&
        range.endContainer === editor &&
        range.endOffset === editor.childNodes.length,
    )
  })

const markdown = (frame: VmdeFrame) =>
  frame
    .locator('body')
    .evaluate(() =>
      (
        window as unknown as { vditor: { getValue(): string } }
      ).vditor.getValue(),
    )

const insertText = (frame: VmdeFrame, text: string) =>
  frame.locator('body').evaluate((_body, insert) => {
    document.execCommand('insertText', false, insert as string)
  }, text)

const copyOf = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    const data = new DataTransfer()
    editor.dispatchEvent(
      new ClipboardEvent('copy', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    )
    return data.getData('text/plain')
  })

const selectFenceBlock = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const surface = (window as any).vditor.vditor.ir.element as HTMLElement
    const block = surface.querySelector<HTMLElement>(
      '[data-type="code-block"]',
    )!
    surface.focus({ preventScroll: true })
    const range = document.createRange()
    range.selectNodeContents(block)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })

const copySelection = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const surface = (
      window as unknown as {
        vditor: { vditor: { ir: { element: HTMLElement } } }
      }
    ).vditor.vditor.ir.element
    const data = new DataTransfer()
    data.setData('text/plain', '__UNSET__')
    data.setData('text/html', '__UNSET__')
    surface.dispatchEvent(
      new ClipboardEvent('copy', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    )
    return {
      plain: data.getData('text/plain'),
      html: data.getData('text/html'),
    }
  })

async function placeText(frame: VmdeFrame, needle: string): Promise<boolean> {
  return frame.locator('body').evaluate((_body, target) => {
    const surface = (
      window as unknown as {
        vditor: { vditor: { ir: { element: HTMLElement } } }
      }
    ).vditor.vditor.ir.element
    // Ctrl+A now reaches Vditor's keydown, whose first-position undo record splits the caret's
    // text node (Task 580 P6); rejoin the halves so the needle is found again.
    surface.normalize()
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = (node.nodeValue ?? '').indexOf(target as string)
      if (index < 0 || node.parentElement?.closest('.vditor-ir__preview'))
        continue
      node.parentElement
        ?.closest<HTMLElement>('[data-block]')
        ?.scrollIntoView({ block: 'center' })
      surface.focus({ preventScroll: true })
      const range = document.createRange()
      range.setStart(node, index + Math.floor((target as string).length / 2))
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      ;(window as any).__vmdeRequestCaret?.({
        node: range.startContainer,
        offset: range.startOffset,
      })
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
    return false
  }, needle)
}

const expandedTarget = (frame: VmdeFrame, needle: string) =>
  frame
    .locator('body')
    .evaluate(
      (_body, target) =>
        Array.from(
          document.querySelectorAll<HTMLElement>('.vditor-ir__node--expand'),
        ).some((node) => (node.textContent ?? '').includes(target as string)),
      needle,
    )

const placeFenceForKey = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const block = document.querySelector<HTMLElement>(
      '.vditor-ir [data-type="code-block"]',
    )
    const source = block?.querySelector<HTMLElement>('.vditor-ir__marker--pre')
    if (!block || !source) return false
    block.classList.add('vditor-ir__node--expand')
    const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT)
    let target: Text | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node.textContent ?? '').includes('const fence')) {
        target = node as Text
        break
      }
    }
    if (!target) return false
    source.focus({ preventScroll: true })
    const range = document.createRange()
    range.setStart(target, 3)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  })

test('real IR structural selection stages scopes without stealing format chords', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const docPath = path.join(baseDir, 'structural-selection.md')
  writeFileSync(docPath, INITIAL)
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath] as [string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'structural-selection fixture readiness' },
  )
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 20, y: 20 } })

  await expect.poll(() => placeText(frame, 'alpha')).toBe(true)
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(() => selectionText(frame)).toContain('alpha')
  expect(await selectionText(frame)).not.toContain('final paragraph')
  expect(await copySelection(frame)).toEqual({
    plain: 'alpha **bold scope** omega',
    html: '',
  })
  await expect.poll(() => placeText(frame, 'alpha')).toBe(true)
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(() => selectionText(frame)).toContain('alpha')
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(() => wholeEditorSelected(frame)).toBe(true)

  await expect.poll(() => placeText(frame, 'bold scope')).toBe(true)
  await expect.poll(() => expandedTarget(frame, 'bold scope')).toBe(true)
  await expect.poll(() => placeText(frame, 'bold scope')).toBe(true)
  await workbox.keyboard.press(EXPAND)
  await expect.poll(() => selectionText(frame)).toBe('bold scope')
  await insertText(frame, 'REPLACED')
  await expect.poll(() => markdown(frame)).toContain('alpha **REPLACED** omega')

  // The fence-source stage comes first from a caret in the code. Vditor's own IR keydown selects
  // the code too; the command's selection snapshot keeps the ladder starting from the caret.
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  expect(await placeFenceForKey(frame)).toBe(true)
  await workbox.keyboard.press(SELECT_ALL)
  await expect
    .poll(async () => (await selectionText(frame)).trim())
    .toBe('const fence = true')
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(() => copyOf(frame)).toContain('```ts')
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(() => wholeEditorSelected(frame)).toBe(true)

  await selectFenceBlock(frame)
  expect(await copyOf(frame)).toContain('```ts')
  await workbox.keyboard.press(SELECT_ALL)
  // Read the Range, not the selection text: measured here, Chromium's text of this
  // element-boundary document selection can stop before the last block.
  await expect.poll(() => wholeEditorSelected(frame)).toBe(true)

  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  // Task 580 CP3-1 — Strikethrough and Bulleted List ship unbound; their commands still act after
  // the structural stages above.
  expect(await placeText(frame, 'strikeword')).toBe(true)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.format.strike')
  })
  await expect.poll(() => markdown(frame)).toContain('~~strikeword~~ remains')
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  expect(await placeText(frame, 'list target')).toBe(true)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.format.list')
  })
  await expect.poll(() => markdown(frame)).toContain('* list target')

  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  expect(await placeText(frame, 'cell one')).toBe(true)
  await workbox.keyboard.press(EXPAND)
  await expect.poll(() => selectionText(frame)).toBe('cell one')
  await workbox.keyboard.press(EXPAND)
  await expect.poll(() => copyOf(frame)).toContain('| cell one | cell two |')

  await expect.poll(() => placeText(frame, 'REPLACED')).toBe(true)
  await expect.poll(() => expandedTarget(frame, 'REPLACED')).toBe(true)
  await workbox.keyboard.press('Escape')
  await expect.poll(() => expandedTarget(frame, 'REPLACED')).toBe(false)
  expect(await selectionText(frame)).toBe('')
  await workbox.keyboard.press('Escape')
  expect(await selectionText(frame)).toContain('alpha')
  await workbox.keyboard.press('Tab')
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(
          () => document.activeElement?.closest('[role="toolbar"]') !== null,
        ),
    )
    .toBe(true)

  // Ctrl+E no longer expands in the webview: VS Code runs its own binding (Quick Open).
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  expect(await placeText(frame, 'final paragraph')).toBe(true)
  await workbox.keyboard.press('Control+e')
  await expect(workbox.locator('.quick-input-widget')).toBeVisible()
  expect(await selectionText(frame)).toBe('')
  await workbox.keyboard.press('Escape')
  await expect(workbox.locator('.quick-input-widget')).toBeHidden()

  // In VMDE's Find input, Select All selects the input's text.
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.find')
  })
  const findInput = frame.locator('.vmde-find-replace input').first()
  await expect(findInput).toBeVisible()
  await findInput.fill('alpha')
  await findInput.evaluate((input: HTMLInputElement) =>
    input.setSelectionRange(2, 2),
  )
  await workbox.keyboard.press(SELECT_ALL)
  await expect
    .poll(() =>
      findInput.evaluate((input: HTMLInputElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    )
    .toEqual([0, 5])
  await workbox.keyboard.press('Escape')
  await expect(frame.locator('.vmde-find-replace')).toBeHidden()

  const finalValue = await markdown(frame)
  expect(finalValue).toContain('alpha **REPLACED** omega')
  expect(finalValue).toContain('~~strikeword~~ remains')
  expect(finalValue).toContain('* list target')
  expect(finalValue).toContain('```ts\nconst fence = true\n```')
})

// Task 580 CP2-6 — outside IR, Select All keeps what the native key did before the guard (Task 580
// P4): the whole surface in WYSIWYG and Split View. Expand Selection has no scopes there. In
// Preview the guard leaves the key to the browser's own select-all and the command does nothing.
test('real Select All selects the whole surface in WYSIWYG and SV, and Preview keeps native select-all', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const docPath = path.join(baseDir, 'structural-selection-modes.md')
  writeFileSync(docPath, INITIAL)
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'structural-selection modes readiness' },
  )
  const switchMode = async (mode: 'wysiwyg' | 'sv') => {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator(`button[data-mode="${mode}"]`).click()
    await waitForE2EReadiness(frame, (state) => state.mode === mode, {
      message: `structural-selection ${mode} readiness`,
    })
  }
  const surfaceSelected = () =>
    frame.locator('body').evaluate(() => {
      const inner = (window as any).vditor.vditor
      const surface = inner[inner.currentMode].element as HTMLElement
      const selection = getSelection()
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null
      return Boolean(
        range &&
          surface.contains(range.startContainer) &&
          surface.contains(range.endContainer) &&
          range.toString().includes('alpha') &&
          range.toString().includes('final paragraph'),
      )
    })

  await switchMode('wysiwyg')
  await frame
    .locator('.vditor-wysiwyg .vditor-reset > p')
    .filter({ hasText: 'final paragraph' })
    .click()
  await workbox.keyboard.press(EXPAND)
  await workbox.waitForTimeout(500)
  expect(await selectionText(frame)).toBe('')
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(surfaceSelected).toBe(true)

  await switchMode('sv')
  await frame
    .locator('.vditor-sv')
    .first()
    .click({ position: { x: 8, y: 8 } })
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(surfaceSelected).toBe(true)
  expect(await selectionText(frame)).toContain('```ts')

  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  const preview = frame.locator('.vditor-preview').first()
  await expect(preview).toBeVisible()
  await preview.getByText('final paragraph').click()
  const beforePreviewSelectAll = await markdown(frame)
  await workbox.keyboard.press(SELECT_ALL)
  // The browser selects the whole webview document, so the rendered preview text with it.
  await expect
    .poll(() => selectionText(frame))
    .toContain('alpha bold scope omega')
  expect(await selectionText(frame)).toContain('final paragraph')
  expect(await markdown(frame)).toBe(beforePreviewSelectAll)
})

// Task 613 — Vditor records an edit in its undo stack `undoDelay` after it, and that snapshot
// restores the selection through VMDE's caret authority. A whole-document Range (and the table
// block stage, `selectNode(table)`) has its endpoints on the editable root; the snapshot used to
// collapse it to the document start. Select All lands inside that window here on purpose.
test('real Select All within undoDelay of an edit survives the undo snapshot, and Delete or type-over replaces the whole document', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const docPath = path.join(baseDir, 'structural-selection-undo-snapshot.md')
  writeFileSync(docPath, INITIAL)
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'structural-selection undo-snapshot readiness' },
  )
  const delay = await frame
    .locator('body')
    .evaluate(
      () => ((window as any).vditor.vditor.options.undoDelay as number) ?? 800,
    )
  // The opening snapshot settles first: a first keydown on a one-entry history runs Vditor's
  // recordFirstPosition, which is outside this task (see tasks/613's follow-up).
  await workbox.waitForTimeout(delay + 200)
  const tableBlockSelected = () =>
    frame.locator('body').evaluate(() => {
      const table = document.querySelector('.vditor-ir table')
      const range = getSelection()?.rangeCount
        ? getSelection()!.getRangeAt(0)
        : null
      const parent = table?.parentNode
      const index = parent
        ? Array.prototype.indexOf.call(parent.childNodes, table)
        : -1
      return Boolean(
        range &&
          parent &&
          range.startContainer === parent &&
          range.startOffset === index &&
          range.endContainer === parent &&
          range.endOffset === index + 1,
      )
    })

  const undoDepth = () =>
    frame
      .locator('body')
      .evaluate(
        () => (window as any).vditor.vditor.undo.ir.undoStack.length as number,
      )
  // A one-code-point prose keystroke skips Vditor's spin; edit-activity.ts re-runs the input
  // 220 ms later on the then-live selection, which is a separate collapse (tasks/613 follow-up).
  // Stage after that settle and before the snapshot that it arms.
  const PROSE_SETTLE_MS = 300

  // Whole-document stage, staged with the edit's snapshot still pending.
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  expect(await placeText(frame, 'final paragraph')).toBe(true)
  let depth = await undoDepth()
  await workbox.keyboard.type('Z')
  await workbox.waitForTimeout(PROSE_SETTLE_MS)
  await workbox.keyboard.press(SELECT_ALL)
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(() => wholeEditorSelected(frame)).toBe(true)
  expect(await undoDepth()).toBe(depth) // the edit's snapshot is still pending
  await expect.poll(undoDepth).toBe(depth + 1)
  await workbox.waitForTimeout(200) // negative assertion: nothing after the snapshot moves it
  expect(await wholeEditorSelected(frame)).toBe(true)
  const edited = await markdown(frame)
  expect(edited).toContain('final pZaragraph')

  // The table block stage is a `selectNode(table)` Range, also on the root.
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  expect(await placeText(frame, 'cell one')).toBe(true)
  depth = await undoDepth()
  await workbox.keyboard.type('X')
  await workbox.waitForTimeout(PROSE_SETTLE_MS)
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(tableBlockSelected).toBe(true)
  expect(await undoDepth()).toBe(depth)
  await expect.poll(undoDepth).toBe(depth + 1)
  await workbox.waitForTimeout(200) // negative assertion: nothing after the snapshot moves it
  expect(await tableBlockSelected()).toBe(true)
  const original = await markdown(frame)
  expect(original).toContain('| cellX one |')

  // Delete and type-over of the whole document, each undone in one step to the exact source.
  for (const [act, expected] of [
    [() => workbox.keyboard.press('Delete'), '\n'],
    [() => workbox.keyboard.type('X'), 'X\n'],
  ] as const) {
    expect(await placeText(frame, 'final pZaragraph')).toBe(true)
    await workbox.keyboard.press(SELECT_ALL)
    await workbox.keyboard.press(SELECT_ALL)
    await expect.poll(() => wholeEditorSelected(frame)).toBe(true)
    await act()
    await expect.poll(() => markdown(frame)).toBe(expected)
    await workbox.waitForTimeout(delay + 200) // record the replacement as its own Undo step
    await workbox.keyboard.press('Control+z')
    await expect.poll(() => markdown(frame)).toBe(original)
  }
})
