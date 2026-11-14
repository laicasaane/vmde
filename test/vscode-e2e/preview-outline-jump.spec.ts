// Task 733 / 012-8: a click on an Outline entry scrolls the shown surface to that heading. Preview
// opened at start and Preview entered from IR are the reported cases; IR is the control. Behaviour
// only: the target heading ends up in the viewport of the surface that is shown.
import { expect, test } from 'vscode-test-playwright'
import {
  closeAllEditors,
  type Frame,
  PREVIEW_BUTTON,
  openFile,
  previewShowing,
  sectionedDocument,
  setConfig,
  waitComplete,
  writeDocument,
} from './preview-mode-helpers'

const OUTLINE_BUTTON = '.vditor-toolbar [data-type="outline"]'
const ITEMS = '.vditor-outline__content li > span[data-target-id]'

test.afterEach(async ({ evaluateInVSCode }) => {
  await closeAllEditors(evaluateInVSCode)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', undefined)
})

const outlineShown = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.vditor-outline')
    return !!panel && getComputedStyle(panel).display !== 'none'
  })

// The Outline state is shared by files: open it with a real toolbar click only when it is closed.
const openOutline = async (frame: Frame) => {
  if (!(await outlineShown(frame))) await frame.locator(OUTLINE_BUTTON).click()
  await expect.poll(() => outlineShown(frame)).toBe(true)
}

const closeOutline = async (frame: Frame) => {
  if (await outlineShown(frame)) await frame.locator(OUTLINE_BUTTON).click()
  await expect.poll(() => outlineShown(frame)).toBe(false)
}

// Where the heading with text `text` sits on the shown surface: in view, or why not.
const headingPlace = (frame: Frame, surface: string, text: string) =>
  frame.locator('body').evaluate(
    (_body, args) => {
      // IR keeps the `## ` marker in the heading text.
      const heading = [
        ...document.querySelectorAll<HTMLElement>(`${args.surface} h2`),
      ].find((h) => h.textContent?.replace(/^#+\s*/, '').trim() === args.text)
      if (!heading) return 'missing'
      const rect = heading.getBoundingClientRect()
      if (rect.height === 0) return 'no layout box'
      return rect.top >= -5 && rect.top < window.innerHeight
        ? 'in view'
        : `top ${Math.round(rect.top)} of ${window.innerHeight}`
    },
    { surface, text },
  )

const clickEntryAndExpectJump = async (
  frame: Frame,
  surface: string,
  text: string,
) => {
  await openOutline(frame)
  const item = frame.locator(ITEMS, { hasText: new RegExp(`^${text}$`) })
  await expect(item).toHaveCount(1, { timeout: 30_000 })
  // The target starts below the first screen, so the jump is observable.
  expect(await headingPlace(frame, surface, text)).not.toBe('in view')
  await item.scrollIntoViewIfNeeded()
  await item.click()
  await expect
    .poll(() => headingPlace(frame, surface, text), { timeout: 20_000 })
    .toBe('in view')
  await closeOutline(frame)
}

const DOC = sectionedDocument(30_000, 'Outline jump')
const TARGET = `Section ${DOC.sections - 3}`

test('an Outline click jumps to the heading in Preview opened at start', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const file = writeDocument(baseDir, 'outline-jump-start.md', DOC.text)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', 'preview')
  const frame = await openFile(evaluateInVSCode, workbox, file)
  await waitComplete(frame)
  await expect.poll(() => previewShowing(frame)).toBe(true)
  await clickEntryAndExpectJump(frame, '.vditor-preview', TARGET)
})

test('an Outline click jumps to the heading in Preview entered from IR', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const file = writeDocument(baseDir, 'outline-jump-entered.md', DOC.text)
  const frame = await openFile(evaluateInVSCode, workbox, file)
  await frame.locator('.vditor-ir h2').first().waitFor({ timeout: 60_000 })
  await frame.locator(PREVIEW_BUTTON).click()
  await expect.poll(() => previewShowing(frame)).toBe(true)
  await waitComplete(frame)
  await expect
    .poll(() =>
      frame.locator('body').evaluate((_body, n) => {
        return document.querySelectorAll('.vditor-preview h2').length >= n
      }, DOC.sections),
    )
    .toBe(true)
  await clickEntryAndExpectJump(frame, '.vditor-preview', TARGET)
  await frame.locator(PREVIEW_BUTTON).click()
  await expect.poll(() => previewShowing(frame)).toBe(false)
})

test('an Outline click jumps to the heading in IR (control)', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const file = writeDocument(baseDir, 'outline-jump-ir.md', DOC.text)
  const frame = await openFile(evaluateInVSCode, workbox, file)
  await frame.locator('.vditor-ir h2').first().waitFor({ timeout: 60_000 })
  await clickEntryAndExpectJump(frame, '.vditor-ir', TARGET)
})
