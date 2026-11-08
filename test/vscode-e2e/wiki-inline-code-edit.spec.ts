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
    // Task 698: the item now continues on a second line, so its last text node no longer ends at
    // the `Explorer sidebar.` anchor of expectedSource; place the caret right after the anchor.
    const anchor = 'Explorer sidebar.'
    const walker = item
      ? document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
      : null
    let text: Text | null = null
    for (let n = walker?.nextNode(); n; n = walker?.nextNode())
      if ((n as Text).data.includes(anchor)) {
        text = n as Text
        break
      }
    if (!item || !text) throw new Error('README list edit target missing')
    item.scrollIntoView({ block: 'center' })
    const range = document.createRange()
    range.setStart(text, text.data.indexOf(anchor) + anchor.length)
    range.collapse(true)
    // Task 698: the click above arms a caret intent that the caret authority re-asserts on every
    // frame (measured: a raw addRange was moved to the heading start one frame later). The
    // deliberate writer retires that intent, so the typed character lands where it is placed.
    if (!(window as any).__vmdeWriteSelection?.(range))
      throw new Error(
        'wiki-inline-code-edit: the deliberate caret write was refused',
      )
    item.focus()
  })
  // Read-only check over two frames: the caret is still inside the README list item.
  for (let frameNumber = 0; frameNumber < 2; frameNumber++) {
    const inItem = await frame.locator('body').evaluate(
      () =>
        new Promise<boolean>((resolve) =>
          requestAnimationFrame(() => {
            const anchor = getSelection()?.anchorNode
            const item = anchor?.parentElement?.closest('li')
            resolve(
              Boolean(item?.textContent?.includes('A built-in outline panel')),
            )
          }),
        ),
    )
    expect(inItem, `caret in the list item, frame ${frameNumber}`).toBe(true)
  }
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
