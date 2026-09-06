import { waitForE2EReadiness, wf } from './webview-helpers'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// NET+PROBE (task 190 P1) — settings must apply to an OPEN editor without reopening (J27, which
// had no real-wire coverage). Two mechanisms: a pure live CSS swap (css.custom → reload-css →
// swapStyle of <style id="custom-css">) and a constructor-only option that forces a live re-init
// (codeLineNumbers → initOnlyChanged → re-init with content preserved). We assert an `outline`
// rule (no specificity war with the theme) applies AND updates, and that the re-init keeps content.
const SRC = path.join(__dirname, 'fixtures', 'torture.md')

test('css.custom and a re-init setting apply live to the open editor', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(120_000)
  const tmp = path.join(tmpdir(), 'vmde-settings-live.md')
  writeFileSync(tmp, readFileSync(SRC, 'utf8'))
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [tmp] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(frame, (snapshot) => snapshot.editorEpoch > 0, {
    message: 'the settings editor finished initialization',
  })

  const setConfig = async (key: string, value: unknown) => {
    const before = await waitForE2EReadiness(frame, () => true)
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: [string, unknown]) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update(args[0], args[1], vscode.ConfigurationTarget.Global)
      },
      [key, value] as [string, unknown],
    )
    if (key === 'editor.codeLineNumbers') {
      await waitForE2EReadiness(
        frame,
        (snapshot) => snapshot.editorEpoch > before.editorEpoch,
        { message: `the ${key} change re-initialized the editor` },
      )
    }
  }

  const outlineColor = () =>
    frame.locator('body').evaluate(() => {
      const el =
        (document.querySelector('.vditor-reset') as HTMLElement) ??
        (document.querySelector('.vditor-ir') as HTMLElement)
      return getComputedStyle(el).outlineColor
    }) as Promise<string>

  try {
    // 1. A live custom-CSS swap applies without reopen.
    await setConfig(
      'css.custom',
      '.vditor-reset{outline:2px solid rgb(3, 5, 7)}',
    )
    await expect
      .poll(outlineColor, { message: 'css.custom applied live' })
      .toBe('rgb(3, 5, 7)')
    // 2. …and a SECOND swap replaces it live (not just an initial injection).
    await setConfig(
      'css.custom',
      '.vditor-reset{outline:2px solid rgb(9, 8, 7)}',
    )
    await expect
      .poll(outlineColor, { message: 'css.custom re-applied live' })
      .toBe('rgb(9, 8, 7)')

    // 3. A constructor-only setting (codeLineNumbers) triggers a live re-init that must NOT
    //    lose the document content.
    await setConfig('editor.codeLineNumbers', true)
    const stillThere = await frame
      .locator('body')
      .evaluate(() =>
        (
          document.querySelector('.vditor-ir') as HTMLElement
        ).innerText.includes('Torture document'),
      )
    expect(stillThere, 're-init after a setting change preserved content').toBe(
      true,
    )
  } finally {
    // Restore globals so the setting change doesn't leak into other specs / the user's config.
    await setConfig('css.custom', '')
    await setConfig('editor.codeLineNumbers', false)
    rmSync(tmp, { force: true })
  }
})
