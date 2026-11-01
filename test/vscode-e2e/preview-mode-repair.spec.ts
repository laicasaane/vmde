// Task 643 review R1: data-safety cases. With the edit view deferred, a settings change that
// re-initialises the editor, or a mode-switch command from Preview, must leave the document intact.
import { expect, test } from 'vscode-test-playwright'
import {
  closeAllEditors,
  PREVIEW_BUTTON,
  docState,
  editTextLength,
  openFile,
  previewShowing,
  sectionedDocument,
  setConfig,
  waitComplete,
  writeDocument,
} from './preview-mode-helpers'

test.afterEach(async ({ evaluateInVSCode }) => {
  await closeAllEditors(evaluateInVSCode)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', undefined)
  await setConfig(evaluateInVSCode, 'editor.codeLineNumbers', undefined)
})

test('a settings re-init while Preview-only keeps the document; leaving Preview then builds it whole', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const { text } = sectionedDocument(20_000, 'Repair re-init')
  const file = writeDocument(baseDir, 'preview-mode-repair-reinit.md', text)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', 'preview')
  const frame = await openFile(evaluateInVSCode, workbox, file)
  await waitComplete(frame)
  expect(await editTextLength(frame)).toBe(0)

  // An init-only setting: the webview re-initialises the editor while no edit view exists. A probe
  // on the old editor instance tells the re-init happened.
  await frame.locator('body').evaluate(() => {
    ;(window as any).__repairProbe = (window as any).vditor
  })
  await setConfig(evaluateInVSCode, 'editor.codeLineNumbers', true)
  await expect
    .poll(
      () =>
        frame
          .locator('body')
          .evaluate(
            () => (window as any).vditor !== (window as any).__repairProbe,
          ),
      { timeout: 60_000 },
    )
    .toBe(true)
  await expect.poll(() => previewShowing(frame), { timeout: 60_000 }).toBe(true)
  await expect(frame.locator('.vditor-preview h2').first()).toBeVisible({
    timeout: 60_000,
  })
  expect(await editTextLength(frame)).toBe(0)

  await frame.locator(PREVIEW_BUTTON).click()
  await expect
    .poll(() => editTextLength(frame), { timeout: 60_000 })
    .toBeGreaterThan(100)
  // Type once: the edit that is posted must be the whole document plus the typed character.
  await frame.locator('.vditor-ir p').first().click()
  await workbox.keyboard.type('Z')
  await expect
    .poll(async () => (await docState(evaluateInVSCode, file)).text, {
      timeout: 30_000,
    })
    .toContain('Z')
  const after = await docState(evaluateInVSCode, file)
  expect(after.text.length).toBe(text.length + 1)
  expect(after.text.replace('Z', '')).toBe(text)
})

test('a mode-switch command from Preview is refused and leaves the document intact', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const { text } = sectionedDocument(20_000, 'Repair switch')
  const file = writeDocument(baseDir, 'preview-mode-repair-switch.md', text)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', 'preview')
  const frame = await openFile(evaluateInVSCode, workbox, file)
  await waitComplete(frame)

  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('vmde.switchToWysiwyg')
  })
  await workbox.waitForTimeout(1500)
  // Still Preview-only: nothing was built or switched, and the file is untouched.
  expect(await previewShowing(frame)).toBe(true)
  expect(await editTextLength(frame)).toBe(0)
  const during = await docState(evaluateInVSCode, file)
  expect(during.text).toBe(text)
  expect(during.dirty).toBe(false)

  await frame.locator(PREVIEW_BUTTON).click()
  await expect
    .poll(() => editTextLength(frame), { timeout: 60_000 })
    .toBeGreaterThan(100)
  await workbox.waitForTimeout(1500)
  const after = await docState(evaluateInVSCode, file)
  expect(after.text).toBe(text)
  expect(after.dirty).toBe(false)
})

test('Rewrap Document while Preview-only is refused: document intact, no extra Undo step', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  // One very long line makes the document rewrappable, so a command that did run would change it.
  const longLine = `${'alpha beta gamma delta '.repeat(20)}end`
  const { text: body } = sectionedDocument(20_000, 'Repair rewrap')
  const text = `${longLine}\n\n${body}`
  const file = writeDocument(baseDir, 'preview-mode-repair-rewrap.md', text)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', 'preview')
  const frame = await openFile(evaluateInVSCode, workbox, file)
  await waitComplete(frame)
  expect(await editTextLength(frame)).toBe(0)

  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('vmde.rewrapDocument')
  })
  await workbox.waitForTimeout(2000)
  expect(await previewShowing(frame)).toBe(true)
  expect(await editTextLength(frame)).toBe(0)
  const during = await docState(evaluateInVSCode, file)
  expect(during.text).toBe(text)
  expect(during.dirty).toBe(false)

  await frame.locator(PREVIEW_BUTTON).click()
  await expect
    .poll(() => editTextLength(frame), { timeout: 60_000 })
    .toBeGreaterThan(100)
  await workbox.waitForTimeout(1500)
  // An Undo after the build has nothing of this webview's to undo, and nothing leaked as an edit.
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('undo')
  })
  await workbox.waitForTimeout(1500)
  const after = await docState(evaluateInVSCode, file)
  expect(after.text).toBe(text)
  expect(after.dirty).toBe(false)
})
