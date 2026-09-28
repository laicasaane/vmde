/**
 * Task 196 — Find & Replace work counters in the real VS Code webview on the large synthetic
 * fixture, in IR, WYSIWYG and SV (one VS Code session; each mode ends by undoing its own Replace
 * All back to the exact baseline). Keyboard input is OS-level XTEST. The gates are the Task 196
 * deterministic work counts (Part 1 "Gates finalized"): query keystrokes, option toggles, scrolling
 * and editor clicks on an unchanged source serialize nothing and build no index; Replace All is one
 * `setValue` whose result equals the exact-source plan in host text. Timing is reported only.
 * Fixture text stays out of the output: document comparisons are booleans.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'
import {
  installFindReplaceProbe,
  type FindReplaceProbeResult,
} from './find-replace-probe'
import {
  CROSS_REGION_TOKEN,
  FIXTURE_SHA256,
  QUERY_TOKEN,
  applyReplacements,
  literalMatches,
} from './find-replace-fixture-helpers'

const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'large-observable-models-synthetic.md',
)
type Mode = 'ir' | 'wysiwyg' | 'sv'
type Frame = ReturnType<typeof wf>
type PhaseResult = FindReplaceProbeResult & { mode: Mode; phase: string }

async function measure(
  frame: Frame,
  mode: Mode,
  phase: string,
  work: () => Promise<unknown>,
): Promise<PhaseResult> {
  await frame
    .locator('body')
    .evaluate(() => (window as any).__vmdeFindReplaceProbe.start())
  await work()
  await frame
    .locator('body')
    .evaluate(() => (window as any).__vmdeFindReplaceProbe.endWorkload())
  // Negative-observation wait: the coalesced Find refresh (150 ms after input) and any paint
  // frame must land inside the phase so their work is counted.
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)))
  const result = (await frame
    .locator('body')
    .evaluate(() =>
      (window as any).__vmdeFindReplaceProbe.stop(),
    )) as FindReplaceProbeResult
  console.log(
    `[Task 196 real-VS-Code phase] ${mode}/${phase}`,
    JSON.stringify(result),
  )
  return { ...result, mode, phase }
}

test.describe('Task 196 OS-level Find & Replace work counters', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('large fixture Find & Replace stays within its work gates in IR, WYSIWYG and SV', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(420_000)
    const initial = readFileSync(FIXTURE, 'utf8')
    expect(createHash('sha256').update(initial).digest('hex')).toBe(
      FIXTURE_SHA256,
    )
    const file = path.join(baseDir, 'find-replace-large-synthetic.md')
    writeFileSync(file, initial)
    const host = async () =>
      (await docText(evaluateInVSCode as never, file)) as string
    await workbox.context().addInitScript(() => {
      ;(window as any).__vmdeBlockHandleCacheMetrics = {
        blockHandleSnapshotCalls: 0,
      }
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
      { timeout: 90_000, message: 'Task 196 large fixture readiness' },
    )
    await expect
      .poll(async () => (await host()) === initial, { timeout: 60_000 })
      .toBe(true)
    await frame.locator('body').evaluate(installFindReplaceProbe)
    const xtest = await createXtestInput(electronApp, workbox)
    expect(xtest.client.visible).toBe(true)
    const widget = frame.locator('.vmde-find-replace')
    const findInput = widget.locator('[data-find]')
    const replaceInput = widget.locator('[data-replace]')
    const status = widget.locator('[data-status]')
    const crossMatches = literalMatches(initial, CROSS_REGION_TOKEN, true)
    const afterAll = applyReplacements(initial, crossMatches, 'ZZZZ')
    const results: PhaseResult[] = []

    for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
      if (mode !== 'ir') {
        await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
        await frame.locator(`button[data-mode="${mode}"]`).click()
        await waitForE2EReadiness(frame, (state) => state.mode === mode, {
          message: `Task 196 ${mode} readiness`,
        })
      }
      const editor = frame
        .locator(mode === 'sv' ? '.vditor-sv' : `.vditor-${mode} .vditor-reset`)
        .first()
      await editor.click({ position: { x: 8, y: 8 } })
      await xtest.activateAndFocus()
      // Find-closed control: there is no warm-index precondition after opening or switching mode,
      // so this phase may pay the first source read. The later Find-open click follows a populated
      // search index and has its own absolute-zero IR gate (Task 578).
      results.push(
        await measure(frame, mode, 'click-find-closed', () =>
          editor.click({ position: { x: 12, y: 12 } }),
        ),
      )
      await xtest.key('ctrl+h')
      await expect(widget).toBeVisible({ timeout: 10_000 })
      await expect(findInput).toBeFocused()
      await expect(replaceInput).toBeVisible()
      await expect(widget.locator('[data-action="case"]')).toHaveAttribute(
        'aria-checked',
        'false',
      )
      // Opening now seeds from the caret. Select that seed before the measured query input.
      await xtest.key('ctrl+a')

      results.push(
        await measure(frame, mode, 'first-keystroke', () =>
          xtest.type(QUERY_TOKEN[0], 20),
        ),
      )
      // Acknowledge delivered XTEST text after each measured input phase, outside its work window.
      await expect(findInput).toHaveValue(QUERY_TOKEN[0])
      await expect(findInput).toBeFocused()
      results.push(
        await measure(frame, mode, 'remaining-keystrokes', () =>
          xtest.type(QUERY_TOKEN.slice(1), 40),
        ),
      )
      await expect(findInput).toHaveValue(QUERY_TOKEN)
      const queryCount = literalMatches(initial, QUERY_TOKEN, false).length
      await expect(status).toHaveText(`1 of ${queryCount}`)
      results.push(
        await measure(frame, mode, 'toggle-case', () =>
          widget.locator('[data-action="case"]').click(),
        ),
      )
      results.push(
        await measure(frame, mode, 'next-previous', async () => {
          for (let step = 0; step < 3; step++)
            await widget.locator('[data-action="next"]').click()
          for (let step = 0; step < 3; step++)
            await widget.locator('[data-action="previous"]').click()
        }),
      )
      results.push(
        await measure(frame, mode, 'scroll', async () => {
          await editor.hover()
          for (let step = 0; step < 3; step++) await workbox.mouse.wheel(0, 500)
        }),
      )
      results.push(
        await measure(frame, mode, 'editor-click', () =>
          editor.click({ position: { x: 12, y: 12 } }),
        ),
      )

      await findInput.click()
      await findInput.focus()
      await expect(findInput).toBeFocused()
      await xtest.key('ctrl+a')
      await xtest.type(CROSS_REGION_TOKEN, 20)
      await expect(findInput).toHaveValue(CROSS_REGION_TOKEN)
      await expect(status).toHaveText(`1 of ${crossMatches.length}`)
      await replaceInput.focus()
      await expect(replaceInput).toBeFocused()
      await xtest.key('ctrl+a')
      await xtest.type('ZZZZ', 20)
      await expect(replaceInput).toHaveValue('ZZZZ')
      results.push(
        await measure(frame, mode, 'replace-all', () =>
          widget.locator('[data-action="replace-all"]').click(),
        ),
      )
      await expect.poll(async () => (await host()) === afterAll).toBe(true)

      // VS Code keeps Find options across close and mode switches. Restore the same case-insensitive
      // starting state for the next measured mode while this widget can still handle its click.
      const caseButton = widget.locator('[data-action="case"]')
      await expect(caseButton).toHaveAttribute('aria-checked', 'true')
      await caseButton.click()
      await expect(caseButton).toHaveAttribute('aria-checked', 'false')

      // Close from the widget, then undo once; assert focus before delivering Escape.
      await widget.locator('[data-find]').click()
      await expect(findInput).toBeFocused()
      await xtest.key('Escape')
      await expect(widget).toBeHidden()
      await xtest.key('ctrl+z')
      await expect
        .poll(async () => (await host()) === initial, {
          message: `${mode}: one Undo restores the exact baseline`,
        })
        .toBe(true)
      await widget.locator('[data-find]').evaluate((input) => {
        ;(input as HTMLInputElement).value = ''
      })
    }

    console.log(
      '[Task 196 real-VS-Code work counters]',
      JSON.stringify(
        results.map((result) => ({
          mode: result.mode,
          phase: result.phase,
          wallMs: result.elapsedWorkloadMs,
          getValue: result.fullGetValueCalls,
          rootLute: result.rootLuteCalls,
          fragmentLute: result.fragmentLuteCalls,
          setValue: result.setValueCalls,
          indexBuilds: result.indexBuilds,
          longTaskMaxMs: result.longTaskMaxMs,
          maxRafGapMs: result.maxRafGapMs,
          overlays: result.overlayCount,
        })),
      ),
    )
    const cheap = results.filter((result) =>
      [
        'remaining-keystrokes',
        'toggle-case',
        'next-previous',
        'scroll',
      ].includes(result.phase),
    )
    const phase = (mode: Mode, name: string) =>
      results.find((result) => result.mode === mode && result.phase === name)!
    const clickExtra = (['ir', 'wysiwyg', 'sv'] as const).filter((mode) => {
      const open = phase(mode, 'editor-click')
      const closed = phase(mode, 'click-find-closed')
      return (
        open.fullGetValueCalls > closed.fullGetValueCalls ||
        open.rootLuteCalls > closed.rootLuteCalls ||
        open.indexBuilds > closed.indexBuilds
      )
    })
    expect(clickExtra).toEqual([])
    const irClick = phase('ir', 'editor-click')
    expect({
      fullGetValueCalls: irClick.fullGetValueCalls,
      rootLuteCalls: irClick.rootLuteCalls,
      indexBuilds: irClick.indexBuilds,
    }).toEqual({ fullGetValueCalls: 0, rootLuteCalls: 0, indexBuilds: 0 })
    const heavy = cheap.filter(
      (result) =>
        result.fullGetValueCalls > 0 ||
        result.rootLuteCalls > 0 ||
        result.indexBuilds > 0,
    )
    expect(heavy.map((result) => `${result.mode}/${result.phase}`)).toEqual([])
    expect(
      results
        .filter((result) => result.phase === 'first-keystroke')
        .every((result) => result.indexBuilds <= 1),
    ).toBe(true)
    expect(
      results
        .filter((result) => result.phase === 'replace-all')
        .every((result) => result.setValueCalls === 1),
    ).toBe(true)

    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    })
    expect(readFileSync(file, 'utf8') === initial).toBe(true)
  })
})
