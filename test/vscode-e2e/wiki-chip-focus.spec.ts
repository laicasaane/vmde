import { wf } from './webview-helpers'
import { createSpecKeyboard } from './helpers/spec-keyboard'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// Task 457 — REWRITTEN. The old contract (Tab reaches a chip, focus ring paints, Enter activates
// it) is dead: 40 consecutive Tab presses in real VS Code never focus a chip (Vditor's `tab: '\t'`
// preventDefaults every Tab in the editable surface — see the task file), and chips shipped WITHOUT
// `tabindex` for exactly that reason (a tabindex only Tab could never reach would become mid-
// paragraph Tab stops the moment Tab is ever freed, which is worse). The new contract is
// caret-targeted activation: place the caret INSIDE a link-like element, confirm the
// `vmde-caret-inside` decoration paints a real outline (main.css's replacement for the dead
// `:focus-visible` rule), then Activate Link at Caret activates it through the SAME
// `activateWikiLink` → `open-wikilink` path the click handler uses: the `vmde.activateLinkAtCaret`
// VS Code command (src/app/commands.ts → `activate-link-at-caret` host message →
// activateLinkAtCaret()). Task 580 CP2-8 made the command unbound and removed the webview's
// Ctrl/Cmd+Enter listener, so the first test now proves Ctrl+Enter is inert.
//
// MUST run inside a real workspace folder: asset-link-actions.ts's getWikiRoot needs
// vscode.workspace.getWorkspaceFolder(uri) to resolve, or wiki links are disabled entirely
// (getWikiDocumentContext returns {enabled:false}, custom-renderer.ts never installs the chip
// renderer, and no `.wiki-link-chip` is ever rendered). The `baseDir` fixture IS the workspace
// folder VS Code is launched with. `Home.md` is pre-created in that SAME root so the target
// resolves to exactly one match: `open-wikilink`'s single-match branch calls `vscode.openWith`
// directly, a clean, deterministic, non-interactive effect to assert on.

// `getValue()` goes through `this.vditor.lute.VditorIRDOM2Md`, and the WASM Lute instance is
// assigned asynchronously — a rendered `.vditor-ir` and a rendered chip do NOT imply it has landed
// (measured: this threw `Cannot read properties of undefined (reading 'VditorIRDOM2Md')` at ~6s
// with both already present). Note the DOUBLE `.vditor`: `window.vditor` is the outer instance,
// `window.vditor.vditor` the inner one that owns `lute`. Poll for it rather than adding a fixed
// settle — task 451's convention.
async function waitForLuteReady(frame: ReturnType<typeof wf>): Promise<void> {
  await frame.locator('body').evaluate(async () => {
    const ready = () => !!(window as any).vditor?.vditor?.lute
    for (let i = 0; i < 300 && !ready(); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready())
      throw new Error('Lute never became available on window.vditor.vditor')
  })
}

function getValue(frame: ReturnType<typeof wf>): Promise<string> {
  return frame.locator('body').evaluate(() => (window as any).vditor.getValue())
}

// Establishes real keyboard-focus context inside the webview iframe (click near, not ON, the
// chip — a plain click on a chip in editable content is intercepted by link-click-fix.ts's own
// click handler, task 229/expand behaviour, not a normal caret placement), then places a COLLAPSED
// Range directly inside the chip's own text. This is what a real `Ctrl+ArrowRight` word-step lands
// on too (task 457's own measurement, chromium harness) — set directly here instead for determinism
// in CI. A REAL browser (unlike jsdom) fires a genuine `selectionchange` event for a JS-driven Range
// change, so caret-link-decorate.ts's observer reacts exactly as it would for a real caret move.
async function placeCaretInChip(
  frame: ReturnType<typeof wf>,
  chip: ReturnType<ReturnType<typeof wf>['locator']>,
): Promise<void> {
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await chip.evaluate((el) => {
    const text = el.firstChild
    if (!text) return
    const range = document.createRange()
    range.setStart(text, Math.min(1, text.textContent?.length ?? 0))
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  })
}

test('Ctrl+Enter no longer activates the link under the caret, and getValue() is unchanged throughout', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(90_000)

  const homePath = path.join(baseDir, 'Home.md')
  const docPath = path.join(baseDir, 'wiki-chip-focus.md')
  writeFileSync(homePath, '# Home\n\nThe target page.\n')
  const docContent =
    '# Wiki chip keyboard focus (task 457)\n\nSee the [[Home]] page for details.\n'
  writeFileSync(docPath, docContent)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  const chip = frame.locator('.wiki-link-chip[data-wiki-target="Home"]')
  await chip.waitFor({ timeout: 60_000 })
  await waitForLuteReady(frame)

  const input = await createSpecKeyboard(electronApp, workbox)
  const baselineValue = await getValue(frame)

  // Task 457 decision 3 — chips ship WITHOUT tabindex: nothing is focusable, so the OLD
  // `:focus-visible` proof is gone. Prove the NEW one instead.
  await placeCaretInChip(frame, chip)
  await expect
    .poll(
      () => chip.evaluate((el) => el.classList.contains('vmde-caret-inside')),
      {
        message:
          'caret-link-decorate.ts must paint vmde-caret-inside on selectionchange',
        timeout: 15_000,
      },
    )
    .toBe(true)
  const outlineStyle = await chip.evaluate(
    (el) => getComputedStyle(el).outlineStyle,
  )
  expect(
    outlineStyle,
    'the vmde-caret-inside outline must actually paint (VS Code injected theme CSS, --vscode-focusBorder)',
  ).toBe('solid')

  // Placing the caret (a selectionchange-only DOM decoration) must not itself touch the document.
  expect(
    await getValue(frame),
    'placing the caret inside the chip must not change the document',
  ).toBe(baselineValue)

  // VMDE_XTEST=1 sends the chord to the verified focused X11 client. The
  // ordinary suite's browser route remains diagnostic only, with no fallback
  // if XTEST setup fails. Task 580 CP2-8: neither the webview nor VS Code acts on it now.
  await input.key('ctrl+Return')
  await new Promise((resolve) => setTimeout(resolve, 1500))

  const homeOpened = await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .some(
          (t) =>
            t.input instanceof vscode.TabInputCustom &&
            t.input.uri.fsPath === args[0],
        ),
    [homePath] as [string],
  )
  expect(homeOpened, 'Ctrl+Enter must not activate the wiki chip').toBe(false)

  // Ctrl+Enter is one keystroke away from inserting a newline (bare Enter); with no VMDE owner it
  // must still leave both the webview value and the source document untouched.
  expect(
    await getValue(frame),
    'Ctrl+Enter must not change the webview value',
  ).toBe(baselineValue)
  const originalDocText = await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.workspace.textDocuments
        .find((d) => d.uri.fsPath === args[0])
        ?.getText() ?? '',
    [docPath] as [string],
  )
  expect(
    originalDocText,
    'Ctrl+Enter must not change the source document',
  ).toBe(docContent)
})

test('vmde.activateLinkAtCaret VS Code command (host trigger) does the same, through message-router', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(90_000)

  const homePath = path.join(baseDir, 'Home.md')
  const docPath = path.join(baseDir, 'wiki-chip-focus-command.md')
  writeFileSync(homePath, '# Home\n\nThe target page.\n')
  const docContent =
    '# Wiki chip command activation (task 457)\n\nSee the [[Home]] page for details.\n'
  writeFileSync(docPath, docContent)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  const chip = frame.locator('.wiki-link-chip[data-wiki-target="Home"]')
  await chip.waitFor({ timeout: 60_000 })
  await waitForLuteReady(frame)

  const baselineValue = await getValue(frame)
  await placeCaretInChip(frame, chip)
  await expect
    .poll(
      () => chip.evaluate((el) => el.classList.contains('vmde-caret-inside')),
      {
        timeout: 15_000,
      },
    )
    .toBe(true)
  expect(await getValue(frame)).toBe(baselineValue)

  // This document's own vmde.editor tab is the one VS Code just opened — still the active tab —
  // so `vmde.activateLinkAtCaret`'s `resolveOpenTarget(undefined, …)` (src/app/commands.ts,
  // getCommandTarget → getActiveTabInput) resolves it, same as `vmde.pastePlain` already does.
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('vmde.activateLinkAtCaret')
  })

  await expect
    .poll(
      async () =>
        evaluateInVSCode(
          async (vscode: typeof import('vscode'), args: string[]) =>
            vscode.window.tabGroups.all
              .flatMap((g) => g.tabs)
              .some(
                (t) =>
                  t.input instanceof vscode.TabInputCustom &&
                  t.input.viewType === 'vmde.editor' &&
                  t.input.uri.fsPath === args[0],
              ),
          [homePath] as [string],
        ),
      { timeout: 15_000, intervals: [300, 600, 1000] },
    )
    .toBe(true)

  const originalDocText = await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.workspace.textDocuments
        .find((d) => d.uri.fsPath === args[0])
        ?.getText() ?? '',
    [docPath] as [string],
  )
  expect(
    originalDocText,
    'command-triggered activation must not change the source document',
  ).toBe(docContent)
})
