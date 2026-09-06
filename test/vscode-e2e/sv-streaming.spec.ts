import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

async function switchMode(
  frame: ReturnType<typeof wf>,
  mode: 'ir' | 'sv',
): Promise<void> {
  await frame.locator('body').evaluate((_body, nextMode) => {
    const inner = (window as any).vditor.vditor
    inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    document
      .querySelector(`.vditor-toolbar button[data-mode="${nextMode}"]`)
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
  }, mode)
}

test('a persisted SV preference streams a huge file directly into split mode', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const smallPath = path.join(baseDir, 'sv-stream-mode.md')
  const hugePath = path.join(baseDir, 'sv-stream-huge.md')
  const tail = 'TASK188_STREAM_TAIL'
  const huge = [
    '# Streamed split document',
    '',
    ...Array.from(
      { length: 14_000 },
      (_, index) =>
        `Paragraph ${index + 1} keeps source streaming measurable and lossless.`,
    ).flatMap((line) => [line, '']),
    tail,
  ].join('\n')
  expect(huge.length).toBeGreaterThan(700_000)
  writeFileSync(smallPath, '# Persist split mode\n')
  writeFileSync(hugePath, huge)

  await evaluateInVSCode(
    async (vscode, args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [smallPath] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  const initial = await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'small-file IR readiness' },
  )
  await switchMode(frame, 'sv')
  await waitForE2EReadiness(
    frame,
    (state) => state.modeEpoch > initial.modeEpoch && state.mode === 'sv',
    { message: 'small-file SV mode readiness' },
  )
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => (window as any).vditor.getCurrentMode()),
    )
    .toBe('sv')
  // save-options is posted by the toolbar mode change; let that host write settle before reopen.
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)))

  await evaluateInVSCode(
    async (vscode, args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [hugePath] as [string],
  )

  await frame.locator('.vditor-sv').waitFor({ timeout: 60_000 })
  await expect
    .poll(() =>
      frame.locator('body').evaluate((_body, expectedTail) => {
        const v = (window as any).vditor?.vditor
        const source = v?.sv?.element as HTMLElement | undefined
        return {
          mode: v?.currentMode,
          sourceVisible: source ? getComputedStyle(source).display : '',
          previewVisible: v?.preview?.element
            ? getComputedStyle(v.preview.element).display
            : '',
          streaming: source?.classList.contains('vmde-streaming') ?? false,
          readOnly: source?.getAttribute('contenteditable') === 'false',
          spinner: !!document.getElementById('vmde-stream-spinner'),
          hasSomeSource: (source?.textContent?.length ?? 0) > 0,
          hasTail: source?.textContent?.includes(expectedTail) ?? false,
        }
      }, tail),
    )
    .toMatchObject({
      mode: 'sv',
      sourceVisible: 'block',
      previewVisible: 'block',
      streaming: true,
      readOnly: true,
      spinner: true,
      hasSomeSource: true,
      hasTail: false,
    })

  await expect
    .poll(
      () =>
        frame.locator('body').evaluate((_body, expectedTail) => {
          const v = (window as any).vditor.vditor
          const source = v.sv.element as HTMLElement
          return {
            valueTail: (window as any).vditor.getValue().includes(expectedTail),
            previewTail:
              v.preview.previewElement.textContent?.includes(expectedTail),
            editable: source.getAttribute('contenteditable'),
            streaming: source.classList.contains('vmde-streaming'),
            spinner: !!document.getElementById('vmde-stream-spinner'),
            metrics: (window as any).__vmdeSVStreamMetrics,
          }
        }, tail),
      { timeout: 120_000 },
    )
    .toMatchObject({
      valueTail: true,
      previewTail: true,
      editable: 'true',
      streaming: false,
      spinner: false,
      metrics: {
        chunks: expect.any(Number),
        totalMs: expect.any(Number),
        maxChunkMs: expect.any(Number),
      },
    })
  const metrics = await frame
    .locator('body')
    .evaluate(() => (window as any).__vmdeSVStreamMetrics)
  console.log(`[sv-streaming] metrics=${JSON.stringify(metrics)}`)
  expect(metrics.chunks).toBeGreaterThan(1)
  expect(metrics.totalMs).toBeGreaterThan(0)
  expect(metrics.maxChunkMs).toBeGreaterThan(0)

  const hostState = await evaluateInVSCode(
    (vscode, args: string[]) => {
      const uri = vscode.Uri.file(args[0])
      const api = vscode.extensions.getExtension('Laicasaane.vmde')?.exports as
        | {
            webviewEditorMode: Map<string, string>
          }
        | undefined
      return api?.webviewEditorMode.get(uri.toString())
    },
    [hugePath] as [string],
  )
  expect(hostState).toBe('sv')

  await frame.locator('.vditor-sv').click()
  await workbox.keyboard.press('Control+End')
  await workbox.keyboard.type(' TASK188_EDIT')
  await expect
    .poll(() =>
      evaluateInVSCode(
        (vscode, args: string[]) =>
          vscode.workspace.textDocuments
            .find((document) => document.uri.fsPath === args[0])
            ?.getText()
            .includes('TASK188_EDIT') ?? false,
        [hugePath] as [string],
      ),
    )
    .toBe(true)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect
    .poll(() => readFileSync(hugePath, 'utf8'))
    .toContain('TASK188_EDIT')

  // Leave the worker-scoped persisted preference at the repository default for later specs.
  await switchMode(frame, 'ir')
})
