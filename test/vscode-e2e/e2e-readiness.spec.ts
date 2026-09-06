import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'list-renumber.md')

test('E2E readiness tracks router, editor, mode, and re-init epochs', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(120_000)
  await evaluateInVSCode(async (vscode) => {
    const config = vscode.workspace.getConfiguration('vmde')
    await config.update(
      'editor.defaultMode',
      'ir',
      vscode.ConfigurationTarget.Global,
    )
    await config.update(
      'editor.codeLineNumbers',
      false,
      vscode.ConfigurationTarget.Global,
    )
  })

  try {
    await evaluateInVSCode(
      async (vscode, args) => {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file((args as string[])[0]),
          'vmde.editor',
        )
      },
      [FIXTURE] as [string],
    )
    const frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })

    const initial = await waitForE2EReadiness(
      frame,
      (state) =>
        state.routerReady &&
        state.editorEpoch > 0 &&
        state.modeEpoch > 0 &&
        state.mode === 'ir',
      { message: 'initial editor readiness' },
    )

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

    const switched = await waitForE2EReadiness(
      frame,
      (state) =>
        state.modeEpoch > initial.modeEpoch && state.mode === 'wysiwyg',
      { message: 'WYSIWYG mode readiness' },
    )

    await evaluateInVSCode(async (vscode) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.codeLineNumbers',
          true,
          vscode.ConfigurationTarget.Global,
        )
    })
    const reinitialized = await waitForE2EReadiness(
      frame,
      (state) => state.editorEpoch > switched.editorEpoch,
      { message: 'editor re-init readiness' },
    )

    expect(reinitialized.routerReady).toBe(true)
    expect(reinitialized.editorEpoch).toBeGreaterThan(initial.editorEpoch)
    expect(reinitialized.modeEpoch).toBeGreaterThan(initial.modeEpoch)
  } finally {
    await evaluateInVSCode(async (vscode) => {
      const config = vscode.workspace.getConfiguration('vmde')
      await config.update(
        'editor.defaultMode',
        undefined,
        vscode.ConfigurationTarget.Global,
      )
      await config.update(
        'editor.codeLineNumbers',
        false,
        vscode.ConfigurationTarget.Global,
      )
    })
  }
})
