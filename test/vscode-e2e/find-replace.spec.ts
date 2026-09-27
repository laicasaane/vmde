/**
 * Task 196 — Find & Replace contract in the real VS Code webview, on the large synthetic fixture
 * (Test fixture scope, task record 2026-09-26: no small control document). Migrated from the
 * original small inline document: Ctrl/Cmd+F opens the widget, Replace All is one exact
 * transaction undone in one step, Ctrl/Cmd+H stays the Headings shortcut, and a single replace
 * persists to disk. The rework adds exact-byte oracles: every expected document is derived from
 * the fixture's exact bytes (Vditor's own serialization differs from them in tables), checked in
 * host text and on disk, and again after save/reopen. Keyboard input is OS-level XTEST.
 * Document comparisons are booleans so fixture text stays out of failure output.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  BOLD_TOKEN,
  CROSS_REGION_TOKEN,
  FIXTURE_SHA256,
  applyReplacements,
  literalMatches,
  wholeWordMatches,
} from './find-replace-fixture-helpers'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'large-observable-models-synthetic.md',
)

test.describe('Task 196 OS-level Find & Replace acceptance', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('Ctrl+F replaces exact source bytes; Undo, Ctrl+H, save and reopen keep them exact', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const initial = readFileSync(FIXTURE, 'utf8')
    expect(createHash('sha256').update(initial).digest('hex')).toBe(
      FIXTURE_SHA256,
    )
    const file = path.join(baseDir, 'find-replace-synthetic.md')
    writeFileSync(file, initial)
    const host = async () =>
      (await docText(evaluateInVSCode as never, file)) as string
    const save = () =>
      evaluateInVSCode(async (vscode) => {
        await vscode.commands.executeCommand('workbench.action.files.save')
      })
    await evaluateInVSCode(async (vscode) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', 'ir', true)
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
      (state) =>
        state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
      { timeout: 90_000, message: 'Task 196 fixture readiness' },
    )
    await expect
      .poll(async () => (await host()) === initial, { timeout: 60_000 })
      .toBe(true)
    // Vditor's rendered serialization differs from the file (root cause 5); Find must not use it.
    const rendered = await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.getValue() as string)
    expect(rendered === initial).toBe(false)

    const xtest = await createXtestInput(electronApp, workbox)
    expect(xtest.client.visible).toBe(true)
    await frame
      .locator('.vditor-ir .vditor-reset')
      .first()
      .click({ position: { x: 8, y: 8 } })
    await xtest.activateAndFocus()

    // --- Ctrl+F opens the widget; Replace All is one exact transaction ---
    await xtest.key('ctrl+f')
    const widget = frame.locator('.vmde-find-replace')
    await expect(widget).toBeVisible({ timeout: 10_000 })
    await expect(widget.locator('[data-find]')).toBeFocused()
    await widget.locator('[data-action="case"]').click()
    await widget.locator('[data-find]').focus()
    await xtest.type(CROSS_REGION_TOKEN, 20)
    const crossMatches = literalMatches(initial, CROSS_REGION_TOKEN, true)
    await expect(widget.locator('[data-status]')).toHaveText(
      `1/${crossMatches.length}`,
    )
    await expect(frame.locator('.vmde-find-overlay--current')).toHaveCount(1)
    // Overlays are rebuilt on every paint: read one and its style in the same evaluation.
    await expect
      .poll(() =>
        frame.locator('body').evaluate(() => {
          const overlay = document.querySelector('.vmde-find-overlay')
          return overlay ? getComputedStyle(overlay).pointerEvents : null
        }),
      )
      .toBe('none')
    await widget.locator('[data-replace]').focus()
    await xtest.key('ctrl+a')
    await xtest.type('ZZZZ', 20)
    await widget.locator('[data-action="replace-all"]').click()
    const afterAll = applyReplacements(initial, crossMatches, 'ZZZZ')
    await expect.poll(async () => (await host()) === afterAll).toBe(true)
    await expect(widget.locator('[data-status]')).toHaveText('0/0')

    // --- One Undo restores the exact baseline, in host text and on disk ---
    // A replace hands focus back to the edited text on its next frame; return to the widget.
    await widget.locator('[data-find]').click()
    await expect(widget.locator('[data-find]')).toBeFocused()
    await xtest.key('Escape')
    await expect(widget).toBeHidden()
    await xtest.key('ctrl+z')
    await expect.poll(async () => (await host()) === initial).toBe(true)
    await save()
    await expect.poll(() => readFileSync(file, 'utf8') === initial).toBe(true)

    // --- Ctrl+H remains the promoted Headings shortcut (Task 505) ---
    await xtest.key('ctrl+h')
    const headings = frame
      .locator('.vditor-toolbar [data-type="headings"]')
      .locator('..')
      .locator('.vditor-hint')
    await expect(headings).toBeVisible({ timeout: 5_000 })
    await xtest.key('Escape')

    // --- A marker-safe single replace inside bold persists to disk; Undo restores exact bytes ---
    await frame
      .locator('.vditor-ir .vditor-reset')
      .first()
      .click({ position: { x: 8, y: 8 } })
    await xtest.key('ctrl+f')
    await expect(widget).toBeVisible()
    await widget.locator('[data-action="word"]').click()
    await widget.locator('[data-find]').focus()
    await xtest.key('ctrl+a')
    await xtest.type(BOLD_TOKEN, 20)
    await expect(widget.locator('[data-status]')).toHaveText('1/1')
    await widget.locator('[data-replace]').focus()
    await xtest.key('ctrl+a')
    await xtest.type('saved phrase', 20)
    await widget.locator('[data-action="replace"]').click()
    const afterOne = applyReplacements(
      initial,
      wholeWordMatches(initial, BOLD_TOKEN, true),
      'saved phrase',
    )
    await expect.poll(async () => (await host()) === afterOne).toBe(true)
    // A replace hands focus back to the edited text on its next frame; return to the widget.
    await widget.locator('[data-find]').click()
    await expect(widget.locator('[data-find]')).toBeFocused()
    await xtest.key('Escape')
    await xtest.key('ctrl+s')
    await expect
      .poll(() => readFileSync(file, 'utf8') === afterOne, { timeout: 15_000 })
      .toBe(true)
    await xtest.key('ctrl+z')
    await expect.poll(async () => (await host()) === initial).toBe(true)
    await save()
    await expect.poll(() => readFileSync(file, 'utf8') === initial).toBe(true)

    // --- Save/reopen gives the same exact bytes ---
    const reopened = await reopenVmdeFixture(
      evaluateInVSCode as never,
      workbox,
      file,
      90_000,
    )
    await waitForE2EReadiness(reopened, (state) => state.editorEpoch > 0, {
      timeout: 90_000,
      message: 'Task 196 reopened fixture readiness',
    })
    expect((await host()) === initial).toBe(true)
    expect(readFileSync(file, 'utf8') === initial).toBe(true)
  })

  test('Task 568 highlighting acceptance: match-only geometry, live settings, light/dark readability', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const initial = readFileSync(FIXTURE, 'utf8')
    expect(createHash('sha256').update(initial).digest('hex')).toBe(
      FIXTURE_SHA256,
    )
    const file = path.join(baseDir, 'find-replace-highlighting.md')
    writeFileSync(file, initial)
    const host = async () =>
      (await docText(evaluateInVSCode as never, file)) as string
    await evaluateInVSCode(async (vscode) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', 'ir', true)
      await vscode.workspace
        .getConfiguration('workbench')
        .update('colorTheme', 'Default Light Modern', true)
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
    try {
      await waitForE2EReadiness(
        frame,
        (state) =>
          state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
        { timeout: 90_000, message: 'Task 568 fixture readiness' },
      )
      await expect
        .poll(async () => (await host()) === initial, { timeout: 60_000 })
        .toBe(true)

      const xtest = await createXtestInput(electronApp, workbox)
      expect(xtest.client.visible).toBe(true)
      await frame
        .locator('.vditor-ir .vditor-reset')
        .first()
        .click({ position: { x: 8, y: 8 } })
      await xtest.activateAndFocus()
      await xtest.key('ctrl+f')
      const widget = frame.locator('.vmde-find-replace')
      await expect(widget).toBeVisible({ timeout: 10_000 })
      await xtest.type(CROSS_REGION_TOKEN, 20)
      // Case/word toggles start off, so this is a plain case-insensitive substring count — the
      // same semantics the widget uses by default.
      const matches = literalMatches(initial, CROSS_REGION_TOKEN, false)
      expect(matches.length).toBeGreaterThan(1)
      await expect(widget.locator('[data-status]')).toHaveText(
        `1/${matches.length}`,
      )

      // Read geometry and computed paint from ONE evaluation per call so a read is never split
      // across a repaint frame. `elementFromPoint` sees the text under an overlay because the
      // overlay layer is `pointer-events: none` (main.css `.vmde-find-overlays`).
      const readOverlays = () =>
        frame.locator('body').evaluate(() => {
          const fallback = document.querySelector(
            '.vditor-ir .vditor-reset',
          ) as HTMLElement | null
          const overlays = Array.from(
            document.querySelectorAll<HTMLElement>('.vmde-find-overlay'),
          )
          return overlays.map((overlay) => {
            const rect = overlay.getBoundingClientRect()
            const cx = Math.min(
              window.innerWidth - 1,
              Math.max(0, rect.left + rect.width / 2),
            )
            const cy = Math.min(
              window.innerHeight - 1,
              Math.max(0, rect.top + rect.height / 2),
            )
            const style = getComputedStyle(overlay)
            const under = document.elementFromPoint(
              cx,
              cy,
            ) as HTMLElement | null
            const container = (under?.closest(
              'p, li, td, th, pre, blockquote, h1, h2, h3, h4, h5, h6, dd, dt',
            ) ??
              under?.closest('.vditor-reset') ??
              fallback) as HTMLElement | null
            const containerRect = container?.getBoundingClientRect() ?? null
            return {
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              containerWidth: containerRect
                ? Math.round(containerRect.width)
                : null,
              isCurrent: overlay.classList.contains(
                'vmde-find-overlay--current',
              ),
              backgroundColor: style.backgroundColor,
              opacity: Number(style.opacity),
              pointerEvents: style.pointerEvents,
            }
          })
        })
      type Overlay = Awaited<ReturnType<typeof readOverlays>>[number]

      // (a) Match-only geometry: every fragment is narrower than the block it sits in (never a
      // containing-block highlight), and no two fragments stack on an identical rect.
      const assertMatchOnlyGeometry = (overlays: Overlay[]) => {
        expect(overlays.length).toBeGreaterThan(1)
        const seen = new Set<string>()
        for (const overlay of overlays) {
          expect(overlay.containerWidth).not.toBeNull()
          expect(overlay.width).toBeLessThan(overlay.containerWidth as number)
          expect(overlay.pointerEvents).toBe('none')
          const key = `${overlay.left}x${overlay.top}x${overlay.width}x${overlay.height}`
          expect(seen.has(key)).toBe(false)
          seen.add(key)
        }
      }

      let overlays = await readOverlays()
      assertMatchOnlyGeometry(overlays)
      // (c) Readability under the light theme with the shipped default opacities: a translucent
      // fill, never an opaque one that would hide the text underneath.
      for (const overlay of overlays) expect(overlay.opacity).toBeLessThan(1)

      await evaluateInVSCode(async (vscode) => {
        await vscode.workspace
          .getConfiguration('workbench')
          .update('colorTheme', 'Default Dark Modern', true)
      })
      await expect
        .poll(
          async () => {
            const list = await readOverlays()
            return (
              list.length > 1 &&
              list.every(
                (overlay) =>
                  overlay.opacity < 1 && overlay.pointerEvents === 'none',
              )
            )
          },
          { timeout: 20_000 },
        )
        .toBe(true)
      overlays = await readOverlays()
      assertMatchOnlyGeometry(overlays)

      // (b) Live settings: vmde.findMatch.* apply to the OPEN widget without reopening it
      // (boot/live-config.ts `applyBodyOptions` -> the `--vmde-find-*` CSS vars main.css reads).
      const ORDINARY_COLOR = 'rgb(10, 40, 90)'
      const CURRENT_COLOR = 'rgb(200, 60, 10)'
      await evaluateInVSCode(async (vscode) => {
        const config = vscode.workspace.getConfiguration('vmde')
        await config.update('findMatch.color', 'rgb(10, 40, 90)', true)
        await config.update('findMatch.opacity', 0.55, true)
        await config.update('findMatch.currentColor', 'rgb(200, 60, 10)', true)
        await config.update('findMatch.currentOpacity', 0.65, true)
      })
      await expect
        .poll(
          async () => {
            const list = await readOverlays()
            const ordinary = list.find((overlay) => !overlay.isCurrent)
            const current = list.find((overlay) => overlay.isCurrent)
            return (
              ordinary?.backgroundColor === ORDINARY_COLOR &&
              Math.abs(ordinary.opacity - 0.55) < 0.01 &&
              current?.backgroundColor === CURRENT_COLOR &&
              Math.abs(current.opacity - 0.65) < 0.01
            )
          },
          { timeout: 20_000 },
        )
        .toBe(true)
      overlays = await readOverlays()
      assertMatchOnlyGeometry(overlays)
      for (const overlay of overlays) expect(overlay.opacity).toBeLessThan(1)

      await xtest.key('Escape')
      await expect(widget).toBeHidden()
    } finally {
      // Reset the live overrides so a later test in this session/file sees shipped defaults.
      await evaluateInVSCode(async (vscode) => {
        const global = vscode.ConfigurationTarget.Global
        const config = vscode.workspace.getConfiguration('vmde')
        await config.update('findMatch.color', undefined, global)
        await config.update('findMatch.opacity', undefined, global)
        await config.update('findMatch.currentColor', undefined, global)
        await config.update('findMatch.currentOpacity', undefined, global)
        await vscode.workspace
          .getConfiguration('workbench')
          .update('colorTheme', undefined, global)
      })
    }
  })
})
