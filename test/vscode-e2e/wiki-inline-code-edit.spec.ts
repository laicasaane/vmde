import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

const README_SOURCE = path.join(__dirname, '..', '..', 'README.md')
const SETTINGS = [
  ['editor.codeLineNumbers', true],
  ['editor.fontSize', '16'],
  ['theme.code', 'github-dark-dimmed'],
  ['editor.fullWidth', false],
  ['theme.content', 'material-dark'],
  ['editor.wrapColumn', 120],
  ['diagram.mermaid.layout', 'elk'],
  ['editor.modifierClickLinks', false],
  ['editor.autoWrapDelay', 500],
] as const
const RESET_KEYS = [
  ...SETTINGS.map(([key]) => key),
  'editor.autoWrap',
  'editor.defaultMode',
  'preview.reflowLineBreaks',
]

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode, keys: string[]) => {
    const config = vscode.workspace.getConfiguration('vmde')
    for (const key of keys)
      await config.update(key, undefined, vscode.ConfigurationTarget.Global)
  }, RESET_KEYS)
})

test('editing the README list keeps backticked [[links]] rendered as inline code', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)
  const source = readFileSync(README_SOURCE, 'utf8')
  const expectedSource = source.replace(
    'Explorer sidebar.',
    'Explorer sidebar.!',
  )
  expect(expectedSource, 'README edit anchor must exist').not.toBe(source)
  const file = path.join(baseDir, 'README.md')
  writeFileSync(file, source)

  await evaluateInVSCode(
    async (
      vscode,
      args: [string, ReadonlyArray<readonly [string, unknown]>],
    ) => {
      const config = vscode.workspace.getConfiguration('vmde')
      for (const [key, value] of args[1])
        await config.update(key, value, vscode.ConfigurationTarget.Global)
      // These omitted settings remain at their manifest defaults for the reported matrix.
      await config.update(
        'editor.autoWrap',
        undefined,
        vscode.ConfigurationTarget.Global,
      )
      await config.update(
        'preview.reflowLineBreaks',
        undefined,
        vscode.ConfigurationTarget.Global,
      )
      await config.update(
        'editor.defaultMode',
        'ir',
        vscode.ConfigurationTarget.Global,
      )
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file, SETTINGS] as [string, ReadonlyArray<readonly [string, unknown]>],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'README wiki inline-code edit readiness' },
  )

  const inlineCode = frame
    .locator('.vditor-ir [data-type="code"]')
    .filter({ hasText: '[[links]]' })
  const incorrectChip = frame.locator(
    '.vditor-ir .wiki-link-chip[data-wiki-target="links"]',
  )
  await expect(inlineCode).toHaveCount(1)
  await expect(incorrectChip).toHaveCount(0)

  await frame.locator('.vditor-ir').click({ position: { x: 24, y: 24 } })
  await frame.locator('body').evaluate(() => {
    const item = Array.from(
      document.querySelectorAll<HTMLElement>('.vditor-ir li'),
    ).find((candidate) =>
      candidate.textContent?.includes('A built-in outline panel'),
    )
    const text = item?.lastChild
    if (!(text instanceof Text))
      throw new Error('README list edit target missing')
    item.scrollIntoView({ block: 'center' })
    const range = document.createRange()
    range.setStart(text, text.data.length)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    item.focus()
  })
  await workbox.keyboard.type('!')

  await expect
    .poll(
      () =>
        frame
          .locator('.vditor-ir li')
          .filter({ hasText: 'A built-in outline panel' })
          .textContent(),
      { timeout: 15_000 },
    )
    .toContain('sidebar.!')
  await expect(inlineCode).toHaveCount(1)
  await expect(inlineCode).toContainText('[[links]]')
  await expect(incorrectChip).toHaveCount(0)

  await expect
    .poll(
      async () =>
        (await evaluateInVSCode(
          async (vscode, filePath: string) =>
            vscode.workspace.textDocuments
              .find((document) => document.uri.fsPath === filePath)
              ?.getText() ?? '',
          file,
        )) as string,
      { timeout: 15_000 },
    )
    .toBe(expectedSource)
})
