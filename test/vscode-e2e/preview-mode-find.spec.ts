// Task 643 (acceptance 7): Find works in Preview, over the rendered text, and Replace is
// unavailable there. Matches are counted and highlighted, Next scrolls the current one into view,
// the Replace row stays hidden, and Replace keys change nothing in the document.
import { expect, test } from 'vscode-test-playwright'
import {
  closeAllEditors,
  PANE,
  docState,
  openFile,
  sectionedDocument,
  setConfig,
  waitComplete,
  writeDocument,
} from './preview-mode-helpers'

test.afterEach(async ({ evaluateInVSCode }) => {
  await closeAllEditors(evaluateInVSCode)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', undefined)
})

test('Find in Preview counts and reveals rendered-text matches; Replace does nothing', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const { text: base } = sectionedDocument(30_000, 'Find fixture')
  const text = `${base}\n## Needle section\n\nThe needle-token is here and needle-token again.\n`
  const file = writeDocument(baseDir, 'preview-mode-find.md', text)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', 'preview')
  const frame = await openFile(evaluateInVSCode, workbox, file)
  await waitComplete(frame)
  const before = await docState(evaluateInVSCode, file)

  {
    await frame.locator(PANE).click({ position: { x: 5, y: 5 } })
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('vmde.findReplace')
    })
    const widget = frame.locator('.vmde-find-replace')
    await expect(widget).toBeVisible({ timeout: 30_000 })
    // A Replace request opens Find only.
    await expect(widget.locator('.vmde-find-replace__row[hidden]')).toHaveCount(
      1,
    )
    await expect(
      widget.locator('[data-action="toggle-replace"]'),
    ).toBeDisabled()

    await widget.locator('[data-find]').fill('needle-token')
    await expect(widget.locator('[role="status"]')).toHaveText('1 of 2')
    await expect
      .poll(() => frame.locator('.vmde-find-overlay').count(), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0)
    // The match is far from the top: it was revealed.
    await expect
      .poll(() =>
        frame.locator('body').evaluate(() => {
          const current = document.querySelector('.vmde-find-overlay--current')
          if (!current) return false
          const top = current.getBoundingClientRect().top
          return top >= 0 && top < window.innerHeight
        }),
      )
      .toBe(true)

    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('vmde.findNext')
    })
    await expect(widget.locator('[role="status"]')).toHaveText('2 of 2')

    // Replace keys and commands change nothing.
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('vmde.findReplace')
    })
    await expect(widget.locator('.vmde-find-replace__row[hidden]')).toHaveCount(
      1,
    )
    await widget.locator('[data-find]').press('Control+Alt+Enter')
    await workbox.waitForTimeout(500)
    const after = await docState(evaluateInVSCode, file)
    expect(after.text).toBe(before.text)
    expect(after.version).toBe(before.version)
    expect(after.dirty).toBe(false)
  }
})
