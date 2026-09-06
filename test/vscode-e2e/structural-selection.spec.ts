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

const selectNextScope = (frame: VmdeFrame, replacement?: string) =>
  frame.locator('body').evaluate((_body, insert) => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'e',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    const selected = getSelection()?.toString() ?? ''
    if (insert !== undefined)
      document.execCommand('insertText', false, insert as string)
    return selected
  }, replacement)

const selectAllStage = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'a',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    return getSelection()?.toString() ?? ''
  })

const selectCellThenTableAndCopy = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    const expand = () =>
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'e',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    expand()
    const cell = getSelection()?.toString() ?? ''
    expand()
    const data = new DataTransfer()
    editor.dispatchEvent(
      new ClipboardEvent('copy', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    )
    return { cell, table: data.getData('text/plain') }
  })

const markdown = (frame: VmdeFrame) =>
  frame
    .locator('body')
    .evaluate(() =>
      (
        window as unknown as { vditor: { getValue(): string } }
      ).vditor.getValue(),
    )

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

const copyFenceBlockAndWiden = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const outer = window as unknown as {
      vditor: { vditor: { ir: { element: HTMLElement } } }
    }
    const surface = outer.vditor.vditor.ir.element
    const block = surface.querySelector<HTMLElement>(
      '[data-type="code-block"]',
    )!
    const range = document.createRange()
    range.selectNodeContents(block)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const data = new DataTransfer()
    surface.dispatchEvent(
      new ClipboardEvent('copy', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    )
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    surface.dispatchEvent(event)
    return {
      copy: data.getData('text/plain'),
      prevented: event.defaultPrevented,
      text: selection.toString(),
    }
  })

async function placeText(frame: VmdeFrame, needle: string): Promise<boolean> {
  return frame.locator('body').evaluate((_body, target) => {
    const surface = (
      window as unknown as {
        vditor: { vditor: { ir: { element: HTMLElement } } }
      }
    ).vditor.vditor.ir.element
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
  await workbox.keyboard.press('Control+a')
  expect(await selectionText(frame)).toContain('alpha')
  expect(await selectionText(frame)).not.toContain('final paragraph')
  expect(await copySelection(frame)).toEqual({
    plain: 'alpha **bold scope** omega',
    html: '',
  })
  await expect.poll(() => placeText(frame, 'alpha')).toBe(true)
  await workbox.keyboard.press('Control+a')
  await expect.poll(() => selectionText(frame)).toContain('alpha')
  await workbox.keyboard.press('Control+a')
  await expect.poll(() => wholeEditorSelected(frame)).toBe(true)

  await expect.poll(() => placeText(frame, 'bold scope')).toBe(true)
  await expect.poll(() => expandedTarget(frame, 'bold scope')).toBe(true)
  await expect.poll(() => placeText(frame, 'bold scope')).toBe(true)
  expect(await selectNextScope(frame, 'REPLACED')).toBe('bold scope')
  await expect.poll(() => markdown(frame)).toContain('alpha **REPLACED** omega')

  let fenceStageAttempts = 0
  let fenceSelection = ''
  for (let attempt = 1; attempt <= 5; attempt++) {
    await frame
      .locator('.vditor-ir')
      .first()
      .click({ position: { x: 4, y: 4 } })
    expect(await placeFenceForKey(frame)).toBe(true)
    fenceSelection = (await selectAllStage(frame)).trim()
    fenceStageAttempts = attempt
    if (fenceSelection === 'const fence = true') break
  }
  expect(fenceSelection).toBe('const fence = true')
  // eslint-disable-next-line no-console
  console.log(
    `[structural-selection] fence source-stage attempts=${fenceStageAttempts}`,
  )
  expect(await copyFenceBlockAndWiden(frame)).toMatchObject({
    copy: expect.stringContaining('```ts'),
    prevented: true,
    text: expect.stringContaining('final paragraph'),
  })

  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  expect(await placeText(frame, 'strikeword')).toBe(true)
  await workbox.keyboard.press('Control+d')
  await expect.poll(() => markdown(frame)).toContain('~~strikeword~~ remains')
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  expect(await placeText(frame, 'list target')).toBe(true)
  await workbox.keyboard.press('Control+l')
  await expect.poll(() => markdown(frame)).toContain('* list target')

  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  expect(await placeText(frame, 'cell one')).toBe(true)
  const tableScope = await selectCellThenTableAndCopy(frame)
  expect(tableScope.cell).toBe('cell one')
  expect(tableScope.table).toContain('| cell one | cell two |')

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

  const finalValue = await markdown(frame)
  expect(finalValue).toContain('alpha **REPLACED** omega')
  expect(finalValue).toContain('~~strikeword~~ remains')
  expect(finalValue).toContain('* list target')
  expect(finalValue).toContain('```ts\nconst fence = true\n```')
})
