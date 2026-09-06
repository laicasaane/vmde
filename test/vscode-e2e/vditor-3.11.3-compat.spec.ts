import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

const SOURCE = path.join(__dirname, 'fixtures', 'vditor-3.11.3-compat.md')
const TEMP = path.join(tmpdir(), 'vmde-vditor-3.11.3-compat.md')
const WYSIWYG_TOKENS = [
  'NestedItem',
  'QuoteInside',
  'ReferenceLabel',
  'CalloutBody',
  'HeadingInside',
]
const SV_TOKENS = ['ImageCaption', 'WaveLabel']
const SUFFIX = 'X'

test('Vditor 3.11.3 changed surfaces edit and save byte-identically', async ({
  workbox,
  evaluateInVSCode,
}) => {
  const before = readFileSync(SOURCE, 'utf8')
  const expected = [...WYSIWYG_TOKENS, ...SV_TOKENS].reduce(
    (markdown, token) => markdown.replace(token, `${token}${SUFFIX}`),
    before,
  )
  writeFileSync(TEMP, before)

  await evaluateInVSCode(
    async (vscode, args) => {
      const [uri] = args as [string]
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [TEMP] as [string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(frame, (snapshot) => snapshot.editorEpoch > 0)
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 8, y: 8 } })

  const switchMode = async (mode: 'ir' | 'sv' | 'wysiwyg') => {
    const beforeSwitch = await waitForE2EReadiness(frame, () => true)
    await frame.locator('body').evaluate((_body, targetMode) => {
      document
        .querySelector(`.vditor-toolbar button[data-mode="${targetMode}"]`)
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
    }, mode)
    await waitForE2EReadiness(
      frame,
      (snapshot) =>
        snapshot.modeEpoch > beforeSwitch.modeEpoch && snapshot.mode === mode,
      { message: `Vditor entered ${mode} mode` },
    )
  }

  const editToken = async (mode: 'ir' | 'sv' | 'wysiwyg', token: string) => {
    const found = await frame.locator('body').evaluate(
      (_body, args) => {
        const [targetMode, needle, insert] = args as [string, string, string]
        const root = document.querySelector(
          targetMode === 'sv'
            ? '.vditor-sv'
            : `.vditor-${targetMode} .vditor-reset`,
        ) as HTMLElement | null
        if (!root) return false
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let text = walker.nextNode() as Text | null
        while (text) {
          const parent = text.parentElement
          const index = text.data.indexOf(needle)
          const excluded = parent?.closest(
            '[contenteditable="false"], [data-render], .vditor-ir__preview, .vditor-wysiwyg__preview',
          )
          if (index >= 0 && !excluded) {
            root.focus()
            const range = document.createRange()
            range.setStart(text, index + needle.length)
            range.collapse(true)
            const selection = getSelection()
            selection?.removeAllRanges()
            selection?.addRange(range)
            return document.execCommand('insertText', false, insert)
          }
          text = walker.nextNode() as Text | null
        }
        return false
      },
      [mode, token, SUFFIX] as [string, string, string],
    )
    expect(found, `editable token found in ${mode}: ${token}`).toBe(true)
    await expect
      .poll(
        () =>
          frame
            .locator('body')
            .evaluate(() => (window as any).vditor.getValue() as string),
        { timeout: 10_000, message: `saved ${mode} edit: ${token}` },
      )
      .toContain(`${token}${SUFFIX}`)
  }

  await switchMode('wysiwyg')
  for (const token of WYSIWYG_TOKENS) await editToken('wysiwyg', token)
  // Image titles and diagram source are intentionally edited in split-view source: in IR their
  // matching text also appears in hidden/render-only nodes, which are not valid browser caret
  // positions. This still drives Vditor's live input/writeback path and keeps the expected bytes
  // unambiguous.
  await switchMode('sv')
  for (const token of SV_TOKENS) await editToken('sv', token)

  // getValue() updates synchronously inside the webview; the extension-host TextDocument follows
  // through the debounced writeback path. Gate the save on that authoritative host state so the
  // final split-view keystroke cannot race the save command.
  await expect
    .poll(
      async () =>
        (await evaluateInVSCode(
          async (vscode: typeof import('vscode'), args: string[]) =>
            vscode.workspace.textDocuments
              .find((document) => document.uri.fsPath === args[0])
              ?.getText(),
          [TEMP] as [string],
        )) as string | undefined,
      { timeout: 15_000, intervals: [200, 300, 500, 800] },
    )
    .toBe(expected)

  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect
    .poll(() => readFileSync(TEMP, 'utf8'), { timeout: 15_000 })
    .toBe(expected)

  const after = readFileSync(TEMP, 'utf8')
  rmSync(TEMP, { force: true })
  expect(after).toBe(expected)
})
