import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  readToolbarFlowProbe,
  toolbarFrameProbeScript,
} from './toolbar-frame-probe'

// 185/3j — large-file STREAMING (task 49) verified in the real custom-editor pipeline.
// Files ≥ ~700k chars (STREAM_MIN_CHARS) render chunk-by-chunk instead of one blocking
// pass; the editor is briefly read-only and must come back fully rendered AND editable.
// This is exactly the webview-pipeline class the AGENTS mandate requires a real-VS-Code
// e2e for — the chromium harness doesn't run the host↔webview init/stream protocol.

const SECTIONS = 1200
// ~620 chars per section × 1200 ≈ 744k chars — safely over the 700k streaming threshold.
function buildLargeMarkdown(): string {
  const parts: string[] = ['# Streaming fixture\n\n']
  for (let i = 0; i < SECTIONS; i++) {
    parts.push(`## Section ${i}\n\n${'lorem ipsum '.repeat(50)}\n\n`)
  }
  return parts.join('')
}

const wf = (workbox: import('@playwright/test').Page) =>
  workbox
    .frameLocator('iframe.webview')
    .frameLocator('iframe[title="VMDE"], #active-frame')

test('streams a >700k-char document to a fully rendered, editable editor', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
}) => {
  // VS Code boot + a 1200-block streamed render both take a while — well over the 90s default.
  test.setTimeout(300_000)
  const file = path.join(os.tmpdir(), `vmde-stream-fixture-${process.pid}.md`)
  fs.writeFileSync(file, buildLargeMarkdown(), 'utf8')

  // Task 661: the painted-frame probe goes in before the editor opens.
  await electronApp.context().addInitScript(toolbarFrameProbeScript)
  const openedAt = Date.now()
  try {
    await evaluateInVSCode(
      async (vscode, [uri]) => {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(uri),
          'vmde.editor',
        )
      },
      [file] as [string],
    )

    const frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 90_000 })

    // Every chunk must land: poll until ALL section headings are in the IR DOM.
    await expect
      .poll(() => frame.locator('.vditor-ir h2').count(), {
        timeout: 150_000,
        intervals: [2_000],
      })
      .toBe(SECTIONS)

    // The LAST section proves the tail chunk streamed in (not just the head).
    await expect(
      frame.locator('.vditor-ir h2', { hasText: `Section ${SECTIONS - 1}` }),
    ).toHaveCount(1)

    test.info().annotations.push({
      type: 'streamMs',
      description: `${Date.now() - openedAt} (open to the last section, not asserted)`,
    })

    // Streaming holds the editor read-only and MUST release it on completion.
    await expect
      .poll(
        () =>
          frame
            .locator('.vditor-ir .vditor-reset')
            .first()
            .getAttribute('contenteditable'),
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBe('true')

    // The streaming spinner must be gone once the document is fully in.
    expect(await frame.locator('#vmde-stream-spinner').count()).toBe(0)

    // Task 661 (acceptance 4): from the first painted frame after the overlay went, the live
    // toolbar was already flowed into its two rows, never a flat stack of controls.
    const probe = await readToolbarFlowProbe(frame)
    test.info().annotations.push({
      type: '661 stream probe',
      description: JSON.stringify({
        frames: probe?.frames,
        liveFrames: probe?.liveFrames,
        liveStreamingFrames: probe?.liveStreamingFrames,
        firstLiveFrame: probe?.firstLiveFrame,
        heightLog: probe?.heightLog,
        violations: probe?.violations,
      }),
    })
    expect(probe?.liveStreamingFrames ?? 0).toBeGreaterThanOrEqual(3)
    expect(probe?.firstLiveFrame?.flatItems).toBe(0)
    expect(probe?.firstLiveFrame?.rows).toBe(2)
    expect(probe?.violations).toEqual([])
  } finally {
    fs.rmSync(file, { force: true })
  }
})
