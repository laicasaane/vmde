/**
 * Task 733 / 036 core C11: Replace All through VMDE's Find widget as test setup. Run 1 showed `ctrl+h` not
 * reaching `vmde.findReplace` (its keybinding `when` needs workbench focus on the editor with no
 * `inputFocus`, which a DOM selection in the webview does not give reliably): the widget never opened.
 * So the widget opens through the extension's own command (`vmde.findReplace`, posting
 * `open-find-replace` in Replace mode), after the editor surface took focus the way the passing Find
 * specs do (a click, then the XTEST window focus). Run 1d showed the command alone failing too on the x4
 * fixture while it streams in, so it is repeated until the Replace row shows. Each field is focused by a click and typed by XTEST;
 * Replace All keeps its key (`ctrl+alt+Return`), then Escape closes the widget.
 */
import type { Locator } from '@playwright/test'
import { expect } from 'vscode-test-playwright'
import {
  type Ctx,
  endSelectionGesture,
  hostText,
  select,
} from './shortcut-xtest-kit'

/** Focused field `input` gets `value` typed by XTEST, replacing what it held. */
async function typeIntoField(ctx: Ctx, input: Locator, value: string) {
  await expect(input).toBeFocused()
  await ctx.kit.xtest.key('ctrl+a')
  await ctx.kit.xtest.type(value, 20)
  await expect(input).toHaveValue(value)
}

/**
 * Replaces every `from` with `to` (case-sensitive) with the caret at `offset` into `needle`; resolves once
 * the host holds `after` and the widget is closed. The caret is put back at the same place.
 */
export async function replaceAllByKeys(
  ctx: Ctx,
  caret: { needle: string; offset: number },
  from: string,
  to: string,
  after: string,
) {
  const widget = ctx.kit.frame().locator('.vmde-find-replace')
  const findInput = widget.locator('[data-find]')
  const replaceInput = widget.locator('[data-replace]')
  await ctx.kit
    .frame()
    .locator('.vditor-ir .vditor-reset')
    .first()
    .click({ position: { x: 8, y: 8 } })
  await ctx.kit.xtest.activateAndFocus()
  await select(ctx, caret.needle, { collapsed: true, offset: caret.offset })
  await endSelectionGesture(ctx)
  // A scaled document (x4) can still be streaming in after the editor reports ready, and an open request
  // is ignored until its edit view is complete (the Chromium harness's `openFind` retries for the same
  // reason): the command is sent again until the Replace row shows.
  await expect
    .poll(
      async () => {
        await ctx.kit.host(async (vscode) => {
          await vscode.commands.executeCommand('vmde.findReplace')
        }, [])
        return replaceInput.isVisible()
      },
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe(true)
  await findInput.click()
  await typeIntoField(ctx, findInput, from)
  // Match Case is a VS Code-wide Find option that survives reopening: turned on only when off.
  const matchCase = widget.locator('[data-action="case"]')
  if ((await matchCase.getAttribute('aria-checked')) !== 'true')
    await matchCase.click()
  await expect(matchCase).toHaveAttribute('aria-checked', 'true')
  await replaceInput.click()
  await typeIntoField(ctx, replaceInput, to)
  await ctx.kit.xtest.key('ctrl+alt+Return')
  await expect
    .poll(async () => (await hostText(ctx)) === after, {
      timeout: 120_000,
      message: 'Replace All applied',
    })
    .toBe(true)
  await ctx.kit.xtest.key('Escape')
  await expect(widget).toBeHidden()
  await select(ctx, caret.needle, { collapsed: true, offset: caret.offset })
  await endSelectionGesture(ctx)
}
