// Task 643 (acceptance 6): the Preview features keep working in the VMDE-rendered Preview. A task
// checkbox changes exactly one source marker and is one Undo step once an edit mode exists; links
// and anchors navigate; the outline lists and activates headings; copy puts the selection on the
// clipboard event; diagram controls are present; the editing toolbar is read-only.
import { expect, test } from 'vscode-test-playwright'
import path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  closeAllEditors,
  PANE,
  PREVIEW_BUTTON,
  docState,
  openFile,
  setConfig,
  waitComplete,
} from './preview-mode-helpers'
import { docText } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'preview-mode-output.md')

test.afterEach(async ({ evaluateInVSCode }) => {
  await closeAllEditors(evaluateInVSCode)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', undefined)
  await setConfig(evaluateInVSCode, 'preview.interactiveCheckboxes', undefined)
})

test('Preview features work without an edit view', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(420_000)
  const text = readFileSync(FIXTURE, 'utf8')
  const file = path.join(baseDir, 'preview-mode-features.md')
  writeFileSync(file, text)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', 'preview')
  await setConfig(evaluateInVSCode, 'preview.interactiveCheckboxes', true)
  const frame = await openFile(evaluateInVSCode, workbox, file)
  await waitComplete(frame)

  // Read-only toolbar state: editing controls are disabled while Preview is up.
  await expect(
    frame.locator('.vditor-toolbar [data-type="bold"].vditor-menu--disabled'),
  ).toHaveCount(1)

  // Anchors: a same-document link scrolls its target (an `id` target and a heading) into view.
  const jump = async (href: string, target: string) => {
    const prevented = await frame
      .locator(`${PANE} a[href="${href}"]`)
      .first()
      .evaluate((a) => {
        const event = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          // Links open on Ctrl/Cmd+click, the same modifier policy as in the edit modes.
          ctrlKey: true,
        })
        a.dispatchEvent(event)
        return event.defaultPrevented
      })
    expect(prevented).toBe(true)
    await expect
      .poll(
        () =>
          frame.locator('body').evaluate((_body, selector) => {
            const el = document.querySelector(selector) as HTMLElement | null
            if (!el) return 'missing'
            const top = el.getBoundingClientRect().top
            return top >= -5 && top < window.innerHeight
              ? 'in view'
              : `top ${Math.round(top)} of ${window.innerHeight}`
          }, target),
        { timeout: 20_000 },
      )
      .toBe('in view')
  }
  await jump('#far-anchor', `${PANE} [id="far-anchor"]`)
  await frame.locator('body').evaluate(() => {
    ;(
      document.querySelector('.vditor-preview .vditor-reset') as HTMLElement
    ).scrollTop = 0
  })
  await jump('#callouts-and-details', `${PANE} h2:nth-of-type(1)`)

  // Outline: lists headings from the Preview and activates one by keyboard.
  await frame.locator('.vditor-toolbar [data-type="outline"]').click()
  const item = frame
    .locator('.vditor-outline__content li > span[data-target-id]', {
      hasText: 'Far section',
    })
    .first()
  await expect(item).toBeVisible({ timeout: 30_000 })
  await item.focus()
  await workbox.keyboard.press('Enter')
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const heading = [
          ...document.querySelectorAll('.vditor-preview h2'),
        ].find((h) => h.textContent === 'Far section') as HTMLElement
        const top = heading.getBoundingClientRect().top
        return top >= -5 && top < window.innerHeight
      }),
    )
    .toBe(true)
  await frame.locator('.vditor-toolbar [data-type="outline"]').click()

  // Copy: the Preview copy handler puts the selected text on the clipboard event.
  const copied = await frame.locator('body').evaluate((_body, selector) => {
    const paragraph = document.querySelector(`${selector} p`) as HTMLElement
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const data = new DataTransfer()
    const event = new ClipboardEvent('copy', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    })
    paragraph.dispatchEvent(event)
    return {
      prevented: event.defaultPrevented,
      text: data.getData('text/plain'),
    }
  }, PANE)
  expect(copied.prevented).toBe(true)
  expect(copied.text).toContain('Intro with a')

  // Diagram controls on a rendered diagram.
  const diagram = frame.locator(`${PANE} .language-mermaid`).first()
  await diagram.scrollIntoViewIfNeeded()
  await expect(diagram.locator('svg')).toHaveCount(1, { timeout: 60_000 })
  await expect(
    frame.locator(`${PANE} .vmde-diagram-controls`).first(),
  ).toBeAttached({
    timeout: 30_000,
  })

  // Task checkboxes: each click is one exact source marker. After leaving Preview every toggle is
  // one Undo step, and the HOST text follows each Undo and Redo (the queued history base must pair
  // with the host text correctly).
  const before = await docState(evaluateInVSCode, file)
  const checkboxes = frame.locator(
    `${PANE} li.vditor-task input[type="checkbox"]`,
  )
  const first = text.replace('- [ ] first real task', '- [x] first real task')
  const both = first.replace('- [ ] third task', '- [x] third task')
  await checkboxes.nth(0).scrollIntoViewIfNeeded()
  await expect(checkboxes.nth(0)).toBeEnabled()
  await checkboxes.nth(0).click()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(first)
  await expect(checkboxes.nth(2)).toBeEnabled()
  await checkboxes.nth(2).click()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(both)
  await expect
    .poll(async () => (await docState(evaluateInVSCode, file)).version)
    .toBe(before.version + 2)

  await frame.locator(PREVIEW_BUTTON).click()
  await expect(frame.locator('.vditor-ir li.vditor-task').first()).toBeVisible({
    timeout: 60_000,
  })
  await frame.locator('.vditor-ir p').first().click()
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(first)
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(text)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(first)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(both)
})
