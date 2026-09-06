import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'auto-theme-pairing.md')

async function activeContentTheme(frame: ReturnType<typeof wf>): Promise<{
  link: string | null
  markdownBody: boolean
  useVscodeVars: string | null
  fontFamily: string
}> {
  return frame.locator('body').evaluate(() => ({
    link:
      [...document.querySelectorAll<HTMLLinkElement>('link[id^="ct-"]')].find(
        (l) => !l.disabled,
      )?.id ?? null,
    markdownBody: document.body.classList.contains('markdown-body'),
    useVscodeVars: document.body.getAttribute('data-use-vscode-theme-color'),
    fontFamily: getComputedStyle(
      document.querySelector('.vditor-reset') ?? document.body,
    ).fontFamily,
  }))
}

test('auto mode pairs with the active standard VS Code content theme', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(120_000)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('theme.content', 'auto', vscode.ConfigurationTarget.Global)
      await vscode.workspace
        .getConfiguration('markdown')
        .update(
          'preview.fontFamily',
          'Arial, sans-serif',
          vscode.ConfigurationTarget.Global,
        )
      await vscode.workspace
        .getConfiguration('workbench')
        .update('colorTheme', 'Dark+', vscode.ConfigurationTarget.Global)
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
  await expect(frame.locator('.vditor-ir')).toHaveCount(1, {
    timeout: 45_000,
  })
  await expect
    .poll(() => activeContentTheme(frame), { timeout: 45_000 })
    .toMatchObject({
      link: 'ct-vscode-dark-2026',
      markdownBody: true,
      useVscodeVars: '0',
    })

  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.workspace
      .getConfiguration('workbench')
      .update('colorTheme', 'Light+', vscode.ConfigurationTarget.Global)
  })
  await expect
    .poll(() => activeContentTheme(frame), { timeout: 45_000 })
    .toMatchObject({
      link: 'ct-vscode-light-2026',
      markdownBody: true,
      useVscodeVars: '0',
    })

  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.workspace
      .getConfiguration('workbench')
      .update('colorTheme', 'Abyss', vscode.ConfigurationTarget.Global)
  })
  await expect
    .poll(() => activeContentTheme(frame), { timeout: 45_000 })
    .toMatchObject({
      link: null,
      markdownBody: false,
      useVscodeVars: '1',
      fontFamily: 'Arial, sans-serif',
    })

  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.workspace
      .getConfiguration('markdown')
      .update(
        'preview.fontFamily',
        'Georgia, serif',
        vscode.ConfigurationTarget.Global,
      )
  })
  await expect
    .poll(() => activeContentTheme(frame), { timeout: 45_000 })
    .toMatchObject({ fontFamily: 'Georgia, serif' })

  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update('theme.content', undefined, vscode.ConfigurationTarget.Global)
    await vscode.workspace
      .getConfiguration('markdown')
      .update(
        'preview.fontFamily',
        undefined,
        vscode.ConfigurationTarget.Global,
      )
    await vscode.workspace
      .getConfiguration('workbench')
      .update(
        'colorTheme',
        'Default Dark Modern',
        vscode.ConfigurationTarget.Global,
      )
  })
})
