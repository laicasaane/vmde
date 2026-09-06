import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

async function openVmde(
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
    [file] as [string],
  )
}

type VmdeFrame = ReturnType<typeof wf>

async function waitReady(frame: VmdeFrame, label: string) {
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { timeout: 120_000, message: label },
  )
}

const positionView = (frame: VmdeFrame, needle: string) =>
  frame.locator('body').evaluate((_body, targetText) => {
    const inner = (window as any).vditor?.vditor
    if (!inner?.ir?.element)
      return {
        found: false,
        inViewport: false,
        caretInTarget: false,
        streaming: false,
        scrollTop: 0,
      }
    const root = inner.ir.element as HTMLElement
    const target = Array.from(root.children).find((block) =>
      (block.textContent ?? '').includes(targetText as string),
    ) as HTMLElement | undefined
    const targetRect = target?.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    const selection = getSelection()
    return {
      found: Boolean(target),
      inViewport: Boolean(
        targetRect &&
          targetRect.bottom > rootRect.top &&
          targetRect.top < rootRect.bottom,
      ),
      caretInTarget: Boolean(
        target &&
          selection?.anchorNode &&
          target.contains(selection.anchorNode),
      ),
      streaming: root.classList.contains('vmde-streaming'),
      scrollTop: root.scrollTop,
    }
  }, needle)

const saveAt = (frame: VmdeFrame, needle: string) =>
  frame.locator('body').evaluate((_body, targetText) => {
    const inner = (window as any).vditor.vditor
    const root = inner.ir.element as HTMLElement
    const target = Array.from(root.children).find((block) =>
      (block.textContent ?? '').includes(targetText as string),
    ) as HTMLElement | undefined
    if (!target) return false
    const rootRect = root.getBoundingClientRect()
    root.scrollTop += target.getBoundingClientRect().top - rootRect.top - 40
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    const node = walker.nextNode()
    if (!node) return false
    root.focus({ preventScroll: true })
    const range = document.createRange()
    range.setStart(node, Math.min(8, node.textContent?.length ?? 0))
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    root.dispatchEvent(new Event('scroll'))
    document.dispatchEvent(new Event('selectionchange'))
    return true
  }, needle)

async function closeAll(
  evaluateInVSCode: (fn: unknown, args: [string]) => Promise<unknown>,
  file: string,
) {
  await evaluateInVSCode(
    async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    },
    [file] as [string],
  )
}

test('restores normal and streamed documents to the saved block and caret', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const normalPath = path.join(baseDir, 'reading-position.md')
  const normalNeedle = 'NORMAL_POSITION_TARGET'
  const normal = [
    '# Normal document',
    '',
    ...Array.from({ length: 100 }, (_, index) =>
      index === 63
        ? `${normalNeedle} paragraph ${index}`
        : `Normal paragraph ${index}`,
    ).flatMap((line) => [line, '']),
  ].join('\n')
  writeFileSync(normalPath, normal)

  await openVmde(evaluateInVSCode, normalPath)
  let frame = wf(workbox)
  await waitReady(frame, 'normal reading-position initial open')
  expect(await saveAt(frame, normalNeedle)).toBe(true)
  await expect
    .poll(() => positionView(frame, normalNeedle))
    .toMatchObject({
      inViewport: true,
      caretInTarget: true,
    })
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))

  await closeAll(evaluateInVSCode, normalPath)
  await openVmde(evaluateInVSCode, normalPath)
  frame = wf(workbox)
  await waitReady(frame, 'normal reading-position reopen')
  await expect
    .poll(() => positionView(frame, normalNeedle))
    .toMatchObject({
      found: true,
      inViewport: true,
      caretInTarget: true,
    })

  const hugePath = path.join(baseDir, 'reading-position-huge.md')
  const hugeNeedle = 'STREAM_POSITION_TARGET'
  const huge = [
    '# Streamed reading position',
    '',
    ...Array.from({ length: 14_000 }, (_, index) =>
      index === 10_500
        ? `${hugeNeedle} ${index} keeps the block identity stable and measurable.`
        : `Stream paragraph ${index} keeps source rendering stable and measurable.`,
    ).flatMap((line) => [line, '']),
  ].join('\n')
  expect(huge.length).toBeGreaterThan(700_000)
  writeFileSync(hugePath, huge)

  await closeAll(evaluateInVSCode, normalPath)
  await openVmde(evaluateInVSCode, hugePath)
  frame = wf(workbox)
  await waitReady(frame, 'streamed reading-position initial open')
  expect(await saveAt(frame, hugeNeedle)).toBe(true)
  await expect
    .poll(() => positionView(frame, hugeNeedle))
    .toMatchObject({
      inViewport: true,
      caretInTarget: true,
      streaming: false,
    })
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))

  await closeAll(evaluateInVSCode, hugePath)
  await openVmde(evaluateInVSCode, hugePath)
  frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await expect
    .poll(() => positionView(frame, hugeNeedle), { timeout: 120_000 })
    .toMatchObject({
      found: true,
      inViewport: true,
      caretInTarget: true,
      streaming: false,
    })
})
