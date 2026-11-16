import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { shippedSwitches, waitForE2EReadiness, wf } from './webview-helpers'

// Task 733 / 015-T2 (task 015 sections 6.2 D-6 and 6.6): the Split pane renders the Source units that
// changed. After each operation the pane's text equals one whole `Md2HTML` of the Source text (rendered
// in the page by the same Lute), and a diagram outside the edited unit keeps its element. Fails until
// 015-I3 lands for the element identity; the text equality holds today.

type Frame = ReturnType<typeof wf>
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

const DOC = [
  'First paragraph of the split fixture.',
  '```mermaid\ngraph TD\n  A --> B\n```',
  'Second paragraph, the one the test edits.',
  '- item one\n- item two',
  'Last paragraph.',
].join('\n\n')

async function openSplit(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: Evaluate,
  file: string,
): Promise<Frame> {
  writeFileSync(file, `${DOC}\n`)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
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
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  const before = await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
    { message: 'the editor installed its router' },
  )
  // The edit-mode buttons sit in a panel hidden until hover: dispatch the click on the button.
  await frame.locator('body').evaluate(() => {
    document
      .querySelector('.vditor-toolbar button[data-mode="sv"]')
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
  })
  await waitForE2EReadiness(
    frame,
    (snapshot) =>
      snapshot.modeEpoch > before.modeEpoch && snapshot.mode === 'sv',
    { message: 'the editor reported Source' },
  )
  await frame
    .locator('.vditor-preview .language-mermaid svg')
    .first()
    .waitFor({ timeout: 30_000 })
  return frame
}

/** The pane's text and the text of one whole `Md2HTML` of the Source text, whitespace collapsed. */
const paneAgainstWhole = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const inner = (
      window as unknown as {
        vditor: {
          vditor: { lute: { Md2HTML(md: string): string } }
          getValue(): string
        }
      }
    ).vditor
    const holder = document.createElement('template')
    holder.innerHTML = inner.vditor.lute.Md2HTML(inner.getValue())
    // Diagram blocks render differently in the pane (engine output); compare the other text only.
    for (const el of Array.from(
      holder.content.querySelectorAll('.language-mermaid'),
    ))
      el.remove()
    const pane = document
      .querySelector('.vditor-preview .vditor-reset')
      ?.cloneNode(true) as HTMLElement | undefined
    for (const el of Array.from(
      pane?.querySelectorAll('.language-mermaid') ?? [],
    ))
      el.remove()
    const norm = (text: string | null | undefined) =>
      (text ?? '').replace(/\s+/g, ' ').trim()
    return {
      pane: norm(pane?.textContent),
      whole: norm(holder.content.textContent),
    }
  })

/** Caret at the end of the Source block whose text starts with `prefix`. */
async function caretAtEndOf(frame: Frame, prefix: string): Promise<void> {
  await frame
    .locator('pre.vditor-sv')
    .first()
    .click({ position: { x: 4, y: 4 } })
  const placed = await frame.locator('body').evaluate((_body, start) => {
    const root = document.querySelector<HTMLElement>('pre.vditor-sv')
    const block = Array.from(root?.children ?? []).find((el) =>
      el.textContent?.startsWith(start as string),
    )
    const text = block
      ? (document
          .createTreeWalker(block, NodeFilter.SHOW_TEXT)
          .nextNode() as Text | null)
      : null
    if (!root || !text) return false
    const range = document.createRange()
    range.setStart(text, text.length)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    root.focus()
    return true
  }, prefix)
  if (!placed) throw new Error('Source block not found')
}

test('the Split pane follows each operation by units and keeps other diagrams', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const frame = await openSplit(
    workbox,
    evaluateInVSCode,
    path.join(baseDir, 'split-units.md'),
  )
  test.skip(
    !(await shippedSwitches(frame)).sourceUnits,
    'Source units ship off',
  )
  // Mark the rendered diagram; a whole re-render of the pane would replace this element.
  await frame
    .locator('.vditor-preview .language-mermaid')
    .first()
    .evaluate((el) => el.setAttribute('data-split-units-mark', '1'))
  await caretAtEndOf(frame, 'Second paragraph')
  const operations: [string, () => Promise<void>][] = [
    ['type', () => workbox.keyboard.type(' more', { delay: 120 })],
    ['backspace', () => workbox.keyboard.press('Backspace', { delay: 120 })],
    ['enter', () => workbox.keyboard.press('Enter', { delay: 120 })],
    ['undo', () => workbox.keyboard.press('Control+z')],
    ['redo', () => workbox.keyboard.press('Control+y')],
  ]
  for (const [name, run] of operations) {
    await run()
    // The Split render debounce plus its render.
    await workbox.waitForTimeout(1500)
    const { pane, whole } = await paneAgainstWhole(frame)
    expect(pane, name).toBe(whole)
    expect(
      await frame
        .locator('.vditor-preview [data-split-units-mark="1"]')
        .count(),
      name,
    ).toBe(1)
  }
})
