import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import { wf } from './webview-helpers'

// MEASUREMENT (Task 733). Cost of one element insertion into a table cell of the synthetic
// table-heavy document in IR mode: append a span, force style with getComputedStyle, time it, remove
// the span. 20 repetitions; prints `STYLE-INSERTION {json}` and, when VMDE_PERF_OUT is set, writes the
// same JSON there. With VMDE_PERF_ASSERT=1 the median must be at most 2 ms; without it the probe never
// fails on a number. The JSON holds numbers only. @probe: excluded from the default run.

const REPETITIONS = 20
const MEDIAN_CEILING_MS = 2

test('style insertion cost in a table cell @probe', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(400_000)
  const file = path.join(baseDir, 'style-insertion.md')
  writeFileSync(file, tableHeavyMarkdown(1))
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 5000)))

  const samples = await frame.locator('body').evaluate((_body, count) => {
    const cell = document.querySelectorAll<HTMLElement>(
      '.vditor-ir .vditor-reset > table td',
    )[7]
    if (!cell) throw new Error('no table cell')
    const out: number[] = []
    for (let i = 0; i < (count as number); i++) {
      const span = document.createElement('span')
      cell.appendChild(span)
      const start = performance.now()
      void getComputedStyle(cell).color
      out.push(performance.now() - start)
      span.remove()
      // Settle the removal outside the timed section.
      void getComputedStyle(cell).color
    }
    return out
  }, REPETITIONS)

  const sorted = [...samples].sort((a, b) => a - b)
  const round = (v: number) => Math.round(v * 100) / 100
  const result = {
    repetitions: samples.length,
    medianMs: round(sorted[Math.floor(sorted.length / 2)]),
    maxMs: round(sorted[sorted.length - 1]),
  }
  const json = JSON.stringify(result)
  console.log(`STYLE-INSERTION ${json}`)
  if (process.env.VMDE_PERF_OUT) writeFileSync(process.env.VMDE_PERF_OUT, json)
  if (process.env.VMDE_PERF_ASSERT === '1')
    expect(result.medianMs).toBeLessThanOrEqual(MEDIAN_CEILING_MS)
})
