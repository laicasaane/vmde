import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'large-observable-models-synthetic.md',
)

test('nonempty large document opens without caret-admission serialization', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const original = readFileSync(FIXTURE, 'utf8')
  const file = path.join(baseDir, 'large-document-caret-admission.md')
  writeFileSync(file, original)

  await workbox.context().addInitScript(() => {
    const win = window as any
    const metrics = { getValueCalls: 0, innerTextReads: 0 }
    win.__vmdeInitialCaretAdmissionProbe = metrics

    const innerTextDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'innerText',
    )
    if (!innerTextDescriptor?.get)
      throw new Error('HTMLElement.innerText getter missing')
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() {
        if (this.tagName === 'CODE') metrics.innerTextReads++
        return innerTextDescriptor.get!.call(this)
      },
      set(value: string) {
        innerTextDescriptor.set?.call(this, value)
      },
    })

    // The extension assigns Vditor before its asynchronous after() initialization.
    // Wrap that instance so the admission path is measured without changing its return value.
    let editor: any
    Object.defineProperty(win, 'vditor', {
      configurable: true,
      get: () => editor,
      set(value) {
        editor = value
        if (!value?.getValue) return
        const getValue = value.getValue.bind(value)
        value.getValue = (...args: unknown[]) => {
          metrics.getValueCalls++
          return getValue(...args)
        }
      },
    })
  })

  await evaluateInVSCode(async (vscode) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.defaultMode', 'ir', true)
    await vscode.workspace
      .getConfiguration('vmde')
      .update('restorePosition', false, true)
  })

  await evaluateInVSCode(
    async (vscode, [uri]: [string]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [file] as [string],
  )

  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.editorEpoch > 0 && state.mode === 'ir',
    {
      timeout: 90_000,
      message: 'large synthetic fixture editor readiness',
    },
  )
  // Observe the complete post-ready init window; this is not used to accept readiness.
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)))

  const result = await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    return {
      getValueCalls: (window as any).__vmdeInitialCaretAdmissionProbe
        .getValueCalls as number,
      innerTextReads: (window as any).__vmdeInitialCaretAdmissionProbe
        .innerTextReads as number,
      mode: (window as any).vditor.getCurrentMode() as string,
      contentVisibility: document.body.classList.contains('vmde-large-doc'),
      blocks: root.children.length,
      tables: root.querySelectorAll('table').length,
      headers: root.querySelectorAll('th').length,
      codeBlocks: root.querySelectorAll('[data-type="code-block"]').length,
    }
  })

  expect(result.mode).toBe('ir')
  expect(result.contentVisibility).toBe(true)
  expect(result.blocks).toBe(265)
  expect(result.tables).toBe(11)
  expect(result.headers).toBe(27)
  expect(result.codeBlocks).toBe(36)
  expect(result.getValueCalls).toBe(0)
  expect(result.innerTextReads).toBe(0)

  // Vditor places copy controls in its Preview render. Compare only booleans so failures never print the fixture.
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  const copyButton = frame
    .locator('.vditor-preview .vditor-copy [data-vmde-copy-code]')
    .first()
  await copyButton.waitFor({ state: 'attached' })
  await copyButton.locator('xpath=ancestor::pre[1]').hover()
  const copyTextarea = copyButton.locator('xpath=../textarea')
  const expectedCopy = (await copyTextarea.inputValue())
    .split(String.fromCharCode(0x200b))
    .join('')
  const sourceBeforeCopy = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue() as string)
  await copyButton.click()
  await expect
    .poll(
      async () =>
        (await evaluateInVSCode(async (vscode: typeof import('vscode')) =>
          vscode.env.clipboard.readText(),
        )) === expectedCopy,
    )
    .toBe(true)
  const sourceAfterCopy = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue() as string)
  expect(sourceAfterCopy === sourceBeforeCopy).toBe(true)
  const innerTextReadsAfterCopy = await frame
    .locator('body')
    .evaluate(
      () =>
        (window as any).__vmdeInitialCaretAdmissionProbe
          .innerTextReads as number,
    )
  expect(innerTextReadsAfterCopy).toBe(0)

  // Equality checks report only a boolean so a failure cannot print fixture Markdown.
  expect((await docText(evaluateInVSCode, file)) === original).toBe(true)
  expect(readFileSync(file, 'utf8') === original).toBe(true)
})
