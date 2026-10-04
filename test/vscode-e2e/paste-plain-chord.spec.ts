import { wf } from './webview-helpers'
// Task 287 in the REAL editor: Paste as Plain Text pastes WITHOUT the rich-HTML conversion.
//
// Task 580 CP3-1: the command is VMDE-only, so it ships unbound; Ctrl+Shift+V no longer reaches it
// (VS Code has no binding for that key with a custom editor focused, so the key does nothing).
// The clipboard read is host-side because a webview cannot read the system clipboard synchronously.
//
// One boot, because the assertion is a CONTRAST: the same clipboard text must come out differently
// under Ctrl+V and the Paste as Plain Text command, or the command is doing nothing
// distinguishable.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'paste-behaviour.md')
// A URL is the cleanest contrast available: Ctrl+V turns it into a markdown link (task 392), so
// plain paste is visible as the ABSENCE of that transformation, with the text still landing.
const URL = 'https://example.com'

test('Paste as Plain Text pastes plain where Ctrl+V would convert, and Ctrl+Shift+V does nothing', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(150_000)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.env.clipboard.writeText(args[0])
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[1]),
        'vmde.editor',
      )
    },
    [URL, FIXTURE] as [string, string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })

  const value = () =>
    frame
      .locator('body')
      .evaluate(
        () =>
          (
            window as unknown as { vditor?: { getValue(): string } }
          ).vditor?.getValue() ?? '',
      )

  const caretAfter = (needle: string) =>
    frame.locator('body').evaluate((_el, n) => {
      const root = document.querySelector('.vditor-ir')
      if (!root) throw new Error('no editor')
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        const i = (t.textContent ?? '').indexOf(n as string)
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(t as Text, i + (n as string).length)
        r.collapse(true)
        const s = window.getSelection()
        s?.removeAllRanges()
        s?.addRange(r)
        ;(t.parentElement as HTMLElement)?.focus()
        return
      }
      throw new Error(`anchor ${n} not found`)
    }, needle)

  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })

  // Baseline: the ordinary chord converts.
  await caretAfter('TARGET')
  await workbox.keyboard.press('Control+v')
  await expect
    .poll(async () => /\[https:\/\/example\.com\]\(/.test(await value()), {
      timeout: 30_000,
      intervals: [300, 500, 1000],
    })
    .toBe(true)

  // The former chord is free: it pastes nothing.
  await caretAfter('CARET')
  const beforeChord = await value()
  await workbox.keyboard.press('Control+Shift+v')
  await workbox.waitForTimeout(1500)
  expect(await value(), 'Ctrl+Shift+V must not paste').toBe(beforeChord)

  // The command: the text lands, but NOT as a link.
  await caretAfter('CARET')
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.pastePlain')
  })
  await expect
    .poll(async () => (await value()).includes(`CARET${URL}`), {
      timeout: 30_000,
      intervals: [300, 500, 1000],
    })
    .toBe(true)

  const v = await value()
  const caretLine = v.split('\n').find((l) => l.includes('CARET')) ?? ''
  expect(caretLine, 'the plain paste inserted the literal text').toContain(
    `CARET${URL}`,
  )
  expect(
    caretLine,
    'and did NOT wrap it as a link the way Ctrl+V does',
  ).not.toMatch(/\[https:\/\/example\.com\]\(/)
})
