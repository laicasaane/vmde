import { waitForE2EReadiness, wf } from './webview-helpers'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// Task 173/174 mode-gate guard — the WYSIWYG code highlighter is now skipped while in IR mode (it was
// scanning `pre.vditor-wysiwyg__pre > code` over the whole mount on every IR keystroke for nothing). The
// risk that gate introduces is that highlighting could fail to kick in after SWITCHING IR→WYSIWYG (the
// harness only boots straight into wysiwyg). This proves it still works in the real custom-editor
// pipeline: open in IR (default), switch to WYSIWYG, and assert a code source gets real hljs token spans.
const FIXTURE = path.join(__dirname, 'fixtures', 'all-renderers.md')

test('WYSIWYG code highlighting still kicks in after switching IR→WYSIWYG (mode-gate)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await evaluateInVSCode(
    async (vscode, args) => {
      const [uri] = args as [string]
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [FIXTURE] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  const before = await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.editorEpoch > 0,
    { message: 'the mode-gate editor finished initialization' },
  )

  // switch IR → WYSIWYG via the edit-mode toolbar (same path as perf-edit.spec.ts)
  await frame.locator('body').evaluate(() => {
    const v = (
      window as unknown as {
        vditor: {
          vditor: { toolbar: { elements: Record<string, HTMLElement> } }
        }
      }
    ).vditor.vditor
    v.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await frame.locator('.vditor-wysiwyg').first().waitFor({ timeout: 30_000 })
  await waitForE2EReadiness(
    frame,
    (snapshot) =>
      snapshot.modeEpoch > before.modeEpoch && snapshot.mode === 'wysiwyg',
    { message: 'the mode gate reported WYSIWYG' },
  )

  // confirm we're in WYSIWYG mode (the gate's predicate), then poll for highlighted token spans in a
  // wysiwyg code source — i.e. the gate let the highlighter run after the switch.
  const mode = await frame
    .locator('body')
    .evaluate(() =>
      (
        window as unknown as { vditor?: { getCurrentMode?: () => string } }
      ).vditor?.getCurrentMode?.(),
    )
  expect(mode).toBe('wysiwyg')

  await expect
    .poll(
      () =>
        frame.locator('body').evaluate(() => {
          const sources = Array.from(
            document.querySelectorAll('pre.vditor-wysiwyg__pre > code'),
          )
          // a source that carries hljs token spans = highlighting ran after the switch
          return sources.some(
            (c) =>
              c.classList.contains('hljs') &&
              c.querySelector('span[class^="hljs-"]') !== null,
          )
        }),
      { timeout: 20_000, intervals: [400, 800, 1500] },
    )
    .toBe(true)
})
