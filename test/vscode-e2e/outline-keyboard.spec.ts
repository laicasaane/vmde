import { wf } from './webview-helpers'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// Task 458 — outline panel keyboard operability. The chromium harness (media-src/e2e/outline.spec.ts)
// already proves the traversal/expand-collapse/activate LOGIC; this spec proves it survives the real
// webview — VS Code's injected CSS/custom-editor pipeline can't be reproduced by the harness (per
// AGENTS.md's mandate for any editor-surface feature).
//
// Per task 456's own root-cause note (a `document.activeElement` read taken in the SAME call stack
// as a `.focus()`/keypress is STALE in the real webview, though fresh one line later): every focus
// check below reads `document.activeElement` in a SEPARATE `evaluate()` from whatever action moved
// focus, and real OS-level keys are dispatched via `workbox.keyboard.press` (outside the frame), not
// a same-stack synthetic call. Durable state (role/tabindex/aria-expanded/getValue()/the resize CSS
// var) is asserted wherever possible; activeElement is the one inherently transient check.

test('outline panel: roving-tabindex tree traversal, expand/collapse, Enter activation, and keyboard resize', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(90_000)

  const fixture = path.join(__dirname, 'fixtures', 'outline-keyboard.md')
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [fixture] as [string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  // `.vditor-ir` appearing is NOT the same instant as Vditor's own internal wiring finishing
  // (preview.element etc. — measured: calling outline.toggle() right after `.vditor-ir` shows up
  // threw "Cannot read properties of undefined (reading 'element')" inside Vditor's own
  // Outline.render, real-VS-Code only, harness never reproduced it). Poll for the preview module
  // outline.render() itself reads before touching it.
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => !!(window as any).vditor?.vditor?.preview?.element),
    )
    .toBe(true)

  // The fixture's outline is off by default (vmde.outline.defaultOpen is false) — force it on
  // the same way the harness's own resize-visibility test does, through Vditor's own toggle path.
  await frame.locator('body').evaluate(() => {
    const v = (window as any).vditor.vditor
    v.outline.toggle(v, true)
  })

  const items = frame.locator('.vditor-outline li span[data-target-id]')
  // installOutlineKeyboard's MutationObserver tags the freshly-rendered outline asynchronously
  // (coalescePerFrame) — poll for the ARIA tag rather than a fixed sleep.
  await expect.poll(() => items.first().getAttribute('role')).toBe('treeitem')
  expect(await items.count()).toBe(3) // the fixture's 3 headings, one nested chain

  const [h1, h2, h3] = [items.nth(0), items.nth(1), items.nth(2)]

  const baselineValue = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue())

  // --- roving tabindex + ArrowDown/Up (real click establishes focus, real keys move it) ---
  await h1.click()
  await expect
    .poll(() => h1.evaluate((el) => el === document.activeElement))
    .toBe(true)
  expect(await h1.getAttribute('tabindex')).toBe('0')
  expect(await h2.getAttribute('tabindex')).toBe('-1')

  await workbox.keyboard.press('ArrowDown')
  await expect
    .poll(() => h2.evaluate((el) => el === document.activeElement))
    .toBe(true)
  expect(await h2.getAttribute('tabindex')).toBe('0')
  expect(await h1.getAttribute('tabindex')).toBe('-1')

  await workbox.keyboard.press('ArrowUp')
  await expect
    .poll(() => h1.evaluate((el) => el === document.activeElement))
    .toBe(true)

  // --- ArrowRight descends (both nodes start expanded), ArrowLeft collapses then ascends ---
  await expect(h1).toHaveAttribute('aria-expanded', 'true')
  await workbox.keyboard.press('ArrowRight') // H1 → H2 (already expanded, so this DESCENDS)
  await expect
    .poll(() => h2.evaluate((el) => el === document.activeElement))
    .toBe(true)
  await workbox.keyboard.press('ArrowRight') // H2 → H3 (leaf)
  await expect
    .poll(() => h3.evaluate((el) => el === document.activeElement))
    .toBe(true)
  await expect(h3).not.toHaveAttribute('aria-expanded', /.+/)

  await workbox.keyboard.press('ArrowLeft') // leaf → parent (H2)
  await expect
    .poll(() => h2.evaluate((el) => el === document.activeElement))
    .toBe(true)
  await workbox.keyboard.press('ArrowLeft') // expanded H2 → collapse in place
  await expect(h2).toHaveAttribute('aria-expanded', 'false')
  await expect
    .poll(() => h2.evaluate((el) => el === document.activeElement))
    .toBe(true) // still on H2 — collapsing does not move focus
  await workbox.keyboard.press('ArrowLeft') // collapsed H2 → ascend to parent (H1)
  await expect
    .poll(() => h1.evaluate((el) => el === document.activeElement))
    .toBe(true)

  // Focus is back on H1 (still expanded); re-expand H2 too (not load-bearing for the checks below,
  // just leaves the panel in a normal, fully-expanded state).
  await workbox.keyboard.press('ArrowRight') // H1 (expanded) → descends to H2 (still collapsed)
  await expect
    .poll(() => h2.evaluate((el) => el === document.activeElement))
    .toBe(true)
  await workbox.keyboard.press('ArrowRight') // H2 (collapsed) → expands in place, stays on H2
  await expect(h2).toHaveAttribute('aria-expanded', 'true')

  // The traversal walk alone (no activation yet) must not have touched the document.
  const afterTraversal = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue())
  expect(afterTraversal).toBe(baselineValue)

  // --- Enter activates via scrollToHeadingIndex (task 243's shared mechanism): flash + no edit ---
  const targetId = await h3.getAttribute('data-target-id')
  await h3.evaluate((el: HTMLElement) => el.focus())
  await workbox.keyboard.press('Enter')
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(
          (_el, id) =>
            document.getElementById(id!)?.classList.contains('heading-flash'),
          targetId,
        ),
    )
    .toBe(true)
  const afterEnter = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue())
  expect(afterEnter).toBe(baselineValue)

  // --- resize separator: role, and Arrow-key resize reflected in the persisted CSS var ---
  const handle = frame.locator('.outline-resize-handle')
  await expect(handle).toHaveAttribute('role', 'separator')
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical')

  const widthNow = () =>
    frame
      .locator('body')
      .evaluate(() =>
        parseFloat(
          getComputedStyle(document.querySelector('.vditor-outline')!).width,
        ),
      )
  // The FIRST keyboard step's basis is `offsetWidth` (border-box), not `widthNow()`'s content-box
  // read — `--me-outline-width` is never explicitly set before this point, so outline-resize.ts
  // falls back to offsetWidth, which is 1px more than the content-box width because of
  // `.vditor-outline`'s resize-handle-side border (same measurement as the chromium harness's
  // equivalent test, media-src/e2e/outline.spec.ts).
  const before = await frame
    .locator('body')
    .evaluate(
      () =>
        (document.querySelector('.vditor-outline') as HTMLElement).offsetWidth,
    )
  await handle.evaluate((el: HTMLElement) => el.focus())
  await workbox.keyboard.press('ArrowLeft') // right-side panel: ArrowLeft grows it
  await expect.poll(widthNow).toBe(before + 10)
})
