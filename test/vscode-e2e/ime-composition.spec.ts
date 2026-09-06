import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

const INITIAL = 'IME guard start\n'

test('real webview wires composition state without disturbing caret or focus', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  const docPath = path.join(baseDir, 'ime-composition.md')
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
    { message: 'IME fixture editor readiness' },
  )
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 8, y: 8 } })
  const result = await frame.locator('body').evaluate(() => {
    const editor = document.querySelector<HTMLElement>('.vditor-ir')!
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let caretNode: Text | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = (node.textContent ?? '').indexOf('IME guard start')
      if (index < 0) continue
      caretNode = node as Text
      const range = document.createRange()
      range.setStart(caretNode, index + 'IME guard start'.length)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus({ preventScroll: true })
      break
    }
    if (!caretNode) throw new Error('IME caret anchor not found')

    const overlay = document.createElement('div')
    overlay.dataset.vmdeOverlay = '1'
    overlay.textContent = 'overlay probe'
    document.body.append(overlay)

    editor.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    )
    const keydown = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    editor.dispatchEvent(keydown)
    const during = {
      composing: document.documentElement.hasAttribute('data-vmde-composing'),
      overlayDisplay: getComputedStyle(overlay).display,
      keyPrevented: keydown.defaultPrevented,
    }

    editor.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    )
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    let textBeforeCaret = ''
    if (range && editor.contains(range.startContainer)) {
      const prefix = document.createRange()
      prefix.selectNodeContents(editor)
      prefix.setEnd(range.startContainer, range.startOffset)
      textBeforeCaret = prefix.toString()
    }
    return {
      during,
      after: {
        composing: document.documentElement.hasAttribute('data-vmde-composing'),
        overlayDisplay: getComputedStyle(overlay).display,
        collapsed: selection?.isCollapsed === true,
        textBeforeCaret,
      },
    }
  })

  expect(result.during).toEqual({
    composing: true,
    overlayDisplay: 'none',
    keyPrevented: false,
  })
  expect(result.after).toMatchObject({
    composing: false,
    collapsed: true,
  })
  expect(result.after.overlayDisplay).not.toBe('none')
  expect(result.after.textBeforeCaret.endsWith('IME guard start')).toBe(true)
  await expect
    .poll(() =>
      frame
        .locator('.vditor-ir')
        .evaluate((editor) =>
          (editor as HTMLElement).contains(document.activeElement),
        ),
    )
    .toBe(true)
})
