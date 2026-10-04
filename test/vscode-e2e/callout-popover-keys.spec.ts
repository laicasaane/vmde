import { wf } from './webview-helpers'
// Task 459 — Activate Link at Caret focuses the callout popover's controls, in the REAL VS Code
// WYSIWYG webview. Task 580 CP2-8 made `vmde.activateLinkAtCaret` unbound and removed the webview
// Ctrl/Cmd+Enter listener, so this spec also proves Ctrl+Enter is inert there. This chord used to be Ctrl/Cmd+Alt+Enter, a SEPARATE chord from
// links/link-click-fix.ts's link-activation Ctrl/Cmd+Enter — the user rejected that (task 459's
// blocker note: a third modifier, and Ctrl+Alt collides with AltGr on a Polish keyboard layout)
// in favour of ONE chord shared through util/caret-gesture.ts, dispatched by whatever is under
// the caret. This spec proves the callout side of that unification in the real webview: WYSIWYG
// only (callout-popover-keys.ts's `calloutBlockquoteAt` gates on `.vditor-wysiwyg`; the popover
// this module targets doesn't exist in IR/Preview, see callouts.ts), because
// `calloutWysiwygToolbar` only appends the `.vmde-callout__type` select to Vditor's own
// block-popover once the caret is INSIDE the blockquote — it is not present at open, so the test
// must poll for it, not assume it.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'callout-popover-keys.md')

// See wiki-chip-focus.spec.ts's identical helper: getValue() goes through the double-`.vditor`
// inner instance's `lute`, assigned asynchronously well after the DOM is rendered.
async function waitForLuteReady(frame: ReturnType<typeof wf>): Promise<void> {
  await frame.locator('body').evaluate(async () => {
    const ready = () => !!(window as any).vditor?.vditor?.lute
    for (let i = 0; i < 300 && !ready(); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready())
      throw new Error('Lute never became available on window.vditor.vditor')
  })
}

function getValue(frame: ReturnType<typeof wf>): Promise<string> {
  return frame.locator('body').evaluate(() => (window as any).vditor.getValue())
}

// `editor.defaultMode` is Global + persistent across boots in this harness (see
// preview-spacing.spec.ts's identical note) — reset unconditionally so a later spec doesn't
// inherit 'wysiwyg'.
test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update(
        'editor.defaultMode',
        undefined,
        vscode.ConfigurationTarget.Global,
      )
  })
})

test('Activate Link at Caret focuses the callout popover controls; Ctrl+Enter is inert; getValue() is unchanged throughout', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(90_000)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.defaultMode',
          'wysiwyg',
          vscode.ConfigurationTarget.Global,
        )
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
  await frame
    .locator('.vditor-wysiwyg blockquote[data-callout]')
    .first()
    .waitFor({ timeout: 60_000 })
  await waitForLuteReady(frame)
  const baselineValue = await getValue(frame)

  // Click into the callout body — real Vditor focus/selection, which is what makes Vditor build
  // its block popover (customWysiwygToolbar -> calloutWysiwygToolbar) in the first place.
  await frame
    .locator('.vditor-wysiwyg blockquote[data-callout]')
    .getByText('Tip body text.')
    .click()

  // The select is appended asynchronously once Vditor's own popover machinery reacts to the
  // selection change — not present at open, so poll rather than assume.
  const select = frame.locator('.vditor-panel .vmde-callout__type')
  await expect(select).toHaveCount(1, { timeout: 15_000 })

  await frame.locator('body').evaluate(() => {
    const root = document.querySelector<HTMLElement>('.vditor-wysiwyg')!
    const paragraph = Array.from(root.querySelectorAll<HTMLElement>('p')).find(
      (candidate) => candidate.textContent?.includes('Tip body text.'),
    )!
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    const text = walker.nextNode() as Text | null
    if (!text) throw new Error('callout body text is unavailable')
    root.focus({ preventScroll: true })
    const range = document.createRange()
    range.setStart(text, Math.min(3, text.data.length))
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    ;(window as any).__vmdeRequestCaret?.({
      node: range.startContainer,
      offset: range.startOffset,
    })
    document.dispatchEvent(new Event('selectionchange'))
  })

  expect(
    await getValue(frame),
    'clicking into the callout body must not change the document',
  ).toBe(baselineValue)

  // Task 580 CP2-8 — Ctrl+Enter, typed at the top level so it crosses the iframe boundary, no
  // longer focuses the controls and leaves the document unchanged.
  await workbox.keyboard.press('Control+Enter')
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(
    await frame
      .locator('.vditor-panel .vmde-callout__type')
      .evaluate((el) => document.activeElement === el),
    'Ctrl+Enter must not focus the callout controls',
  ).toBe(false)
  expect(await getValue(frame), 'Ctrl+Enter must not change the document').toBe(
    baselineValue,
  )

  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('vmde.activateLinkAtCaret')
  })

  await expect
    .poll(
      () =>
        frame
          .locator('.vditor-panel .vmde-callout__type')
          .evaluate((el) => document.activeElement === el),
      { timeout: 15_000 },
    )
    .toBe(true)

  // The action must not edit — both in the webview's own getValue() and the underlying document.
  expect(
    await getValue(frame),
    'focusing the popover via Activate Link at Caret must not change the document',
  ).toBe(baselineValue)
  const docText = await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.workspace.textDocuments
        .find((d) => d.uri.fsPath === args[0])
        ?.getText() ?? '',
    [FIXTURE] as [string],
  )
  expect(docText, 'the underlying source document must be untouched').toBe(
    baselineValue,
  )
})
