import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

const SOURCE_FIXTURE = path.join(__dirname, 'fixtures', 'sv-source-links.md')
const TARGET_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'sv-source-link-target.md',
)
const EXTERNAL = 'https://example.com/sv-source?q=raw#fragment'

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update(
        'editor.modifierClickLinks',
        undefined,
        vscode.ConfigurationTarget.Global,
      )
  })
})

test('split-source links reuse the configured secure opener without changing Markdown', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const source = path.join(baseDir, 'sv-source-links.md')
  const target = path.join(baseDir, 'sv-source-link-target.md')
  const original = readFileSync(SOURCE_FIXTURE, 'utf8')
  writeFileSync(source, original)
  writeFileSync(target, readFileSync(TARGET_FIXTURE, 'utf8'))

  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      const global = globalThis as unknown as { __svExternal?: string[] }
      global.__svExternal = []
      vscode.env.openExternal = (async (uri: import('vscode').Uri) => {
        global.__svExternal!.push(uri.toString(true))
        return true
      }) as typeof vscode.env.openExternal
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.modifierClickLinks',
          true,
          vscode.ConfigurationTarget.Global,
        )
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [source] as [string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'Task 542 IR readiness' },
  )
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="sv"]').click()
  await frame.locator('.vditor-sv').waitFor({ timeout: 30_000 })
  await waitForE2EReadiness(frame, (state) => state.mode === 'sv', {
    message: 'Task 542 split-source readiness',
  })
  const svBaseline = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue())

  const externalLabel = frame
    .locator('.vditor-sv [data-type="link-text"]')
    .filter({ hasText: 'External' })
  const externalDestination = frame
    .locator('.vditor-sv .vditor-sv__marker--link')
    .filter({ hasText: EXTERNAL })
  const hostExternal = () =>
    evaluateInVSCode(async () => {
      return (
        (globalThis as unknown as { __svExternal?: string[] }).__svExternal ??
        []
      )
    }) as Promise<string[]>

  await externalLabel.click()
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
  expect(await hostExternal()).toEqual([])
  const plainClickState = await frame.locator('body').evaluate(() => {
    const source = document.querySelector('.vditor-sv')
    const selection = getSelection()
    const anchor = selection?.rangeCount
      ? selection.getRangeAt(0).startContainer
      : null
    return {
      focused: document.activeElement === source,
      selectionInSource: Boolean(anchor && source?.contains(anchor)),
    }
  })
  expect(plainClickState).toEqual({ focused: true, selectionInSource: true })

  await externalDestination.click({ modifiers: ['Control'] })
  await expect.poll(hostExternal).toEqual([EXTERNAL])
  await frame
    .locator(`.vditor-preview a[href="${EXTERNAL}"]`)
    .click({ modifiers: ['Control'] })
  await expect.poll(hostExternal).toEqual([EXTERNAL, EXTERNAL])
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.getValue()),
  ).toBe(svBaseline)

  await evaluateInVSCode(async (vscode) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update(
        'editor.modifierClickLinks',
        false,
        vscode.ConfigurationTarget.Global,
      )
  })
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() =>
        (window as any).__vmdeShouldOpenLink?.({
          ctrlKey: false,
          metaKey: false,
        }),
      ),
    )
    .toBe(true)
  await frame
    .locator('.vditor-sv [data-type="link-text"]')
    .filter({ hasText: 'Local target' })
    .click()

  await expect
    .poll(
      () =>
        evaluateInVSCode(async (vscode) =>
          vscode.window.tabGroups.all.flatMap((group) =>
            group.tabs.map((tab) => {
              const input = tab.input as
                | { uri?: { fsPath?: string }; viewType?: string }
                | undefined
              return {
                fsPath: input?.uri?.fsPath,
                viewType: input?.viewType,
              }
            }),
          ),
        ) as Promise<Array<{ fsPath?: string; viewType?: string }>>,
      { timeout: 15_000 },
    )
    .toContainEqual({ fsPath: target, viewType: 'vmde.editor' })

  const sourceState = (await evaluateInVSCode(
    async (vscode, args: [string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === args[0],
      )
      return { text: document?.getText(), dirty: document?.isDirty }
    },
    [source] as [string],
  )) as { text: string; dirty: boolean }
  expect(sourceState).toEqual({ text: original, dirty: false })
  expect(readFileSync(source, 'utf8')).toBe(original)
})
