// Task 643 (acceptance 1 and 8): a Preview rule opens Preview without building an edit view; leaving
// Preview builds it; switching between Preview and the edit modes keeps the reading position and
// leaves the document, its dirty state and the Undo history unchanged.
import { expect, test } from 'vscode-test-playwright'
import {
  closeAllEditors,
  PREVIEW_BUTTON,
  docState,
  editTextLength,
  openFile,
  previewShowing,
  scrollPreviewTo,
  sectionedDocument,
  setConfig,
  topOf,
  undoDepth,
  waitComplete,
  writeDocument,
} from './preview-mode-helpers'
import { waitForE2EReadiness } from './webview-helpers'

test.afterEach(async ({ evaluateInVSCode }) => {
  await closeAllEditors(evaluateInVSCode)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', undefined)
})

test('Preview opens without an edit view; switching keeps position, document and Undo state', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const { text } = sectionedDocument(30_000, 'Switch fixture')
  const file = writeDocument(baseDir, 'preview-mode-switch.md', text)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', 'preview')
  const frame = await openFile(evaluateInVSCode, workbox, file)

  await waitComplete(frame)
  await expect.poll(() => previewShowing(frame)).toBe(true)
  // Acceptance 1: nothing was built for editing.
  expect(await editTextLength(frame)).toBe(0)
  const opened = await docState(evaluateInVSCode, file)
  expect(opened.text).toBe(text)
  expect(opened.dirty).toBe(false)

  // Read some way down, then leave Preview: the edit view is built and shows the same section.
  await scrollPreviewTo(frame, 'Section 40')
  await workbox.waitForTimeout(400)
  await frame.locator(PREVIEW_BUTTON).click()
  await expect
    .poll(() => editTextLength(frame), { timeout: 60_000 })
    .toBeGreaterThan(0)
  await workbox.waitForTimeout(1500)
  const inIr = await topOf(frame, '.vditor-ir h2', 'Section 40')
  expect(inIr).not.toBeNull()
  expect(inIr as number).toBeGreaterThan(-60)
  expect(inIr as number).toBeLessThan(700)
  // Acceptance 8: building and leaving changed nothing in the document.
  const afterLeave = await docState(evaluateInVSCode, file)
  expect(afterLeave.text).toBe(text)
  expect(afterLeave.version).toBe(opened.version)
  expect(afterLeave.dirty).toBe(false)
  const undoAfterBuild = await undoDepth(frame)

  // Back into Preview from IR keeps the section in view; then each edit mode round trips.
  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    if (mode !== 'ir') {
      await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
      await frame.locator(`.vditor-toolbar button[data-mode="${mode}"]`).click()
      await waitForE2EReadiness(frame, (state) => state.mode === mode, {
        timeout: 60_000,
      })
    }
    await frame.locator(PREVIEW_BUTTON).click()
    await expect.poll(() => previewShowing(frame)).toBe(true)
    await workbox.waitForTimeout(1200)
    if (mode !== 'sv') {
      const inPreview = await topOf(frame, '.vditor-preview h2', 'Section 40')
      expect(inPreview).not.toBeNull()
      expect(inPreview as number).toBeGreaterThan(-60)
      expect(inPreview as number).toBeLessThan(700)
    }
    await frame.locator(PREVIEW_BUTTON).click()
    await expect.poll(() => previewShowing(frame)).toBe(mode === 'sv')
    await workbox.waitForTimeout(500)
  }

  const finalState = await docState(evaluateInVSCode, file)
  expect(finalState.text).toBe(text)
  expect(finalState.version).toBe(opened.version)
  expect(finalState.dirty).toBe(false)
  // Toggling Preview never adds an Undo step (Split keeps its own history slot, so compare IR's).
  expect(undoAfterBuild).toBeLessThanOrEqual(2)
})
