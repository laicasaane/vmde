import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 733 / 012-2, gate G4: Undo and Redo in a table cell. The drive is the edit-latency probe's
// table cell place (typing at two cadences, Backspace, Enter, paste), so a wrap hint lands inside
// the edited cell's text after its capture: that hint made the first Undo refuse and clear the
// history, and every later passive Details read took the whole-document snapshot and exact
// fallback. The counters (`window.__vmdeEditCounters`, end-to-end runs only) cover the Undo and Redo
// phase. The cell text is compared inside the page; no document text leaves it.

type Frame = ReturnType<typeof wf>

const fixture = tableHeavyMarkdown(1)
const CELL = '.vditor-ir .vditor-reset > table td'
const CELL_NTH = 7

async function openCellFixture(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: (fn: unknown, args: string[]) => Promise<unknown>,
  baseDir: string,
): Promise<Frame> {
  const file = path.join(baseDir, 'cell-history-gates.md')
  writeFileSync(file, fixture)
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
  await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
    { message: 'the cell-history editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  return frame
}

/** Numbers only: the counters of the Undo and Redo phase. */
const readHistoryCounters = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const c = (
      window as unknown as { __vmdeEditCounters: Record<string, number> }
    ).__vmdeEditCounters
    return {
      fullGetValue: c.fullGetValue,
      luteDocument: c.luteDocument,
      luteTable: c.luteTable,
      legacyEditPosts: c.legacyEditPosts,
      historyDeltaPosts: c.historyDeltaPosts,
      deltaPosts: c.deltaPosts,
    }
  })

test.describe('cell history gates', () => {
  test('Undo and Redo in a table cell make no whole-document call', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const frame = await openCellFixture(workbox, evaluateInVSCode, baseDir)
    const cell = frame.locator(CELL).nth(CELL_NTH)
    await cell.scrollIntoViewIfNeeded()
    await cell.click()
    await workbox.keyboard.press('End')
    const press = async (key: string, times: number, gapMs: number) => {
      for (let i = 0; i < times; i++) {
        await workbox.keyboard.press(key)
        await workbox.waitForTimeout(gapMs)
      }
    }
    // A negative-assertion wait: the idle publication and the wrap-hint pass run before the next
    // step, as the probe's 3 s window lets them run.
    const settle = () => workbox.waitForTimeout(3000)
    for (const gapMs of [80, 300]) {
      for (const ch of 'abcdefghij') {
        await workbox.keyboard.press(ch)
        await workbox.waitForTimeout(gapMs)
      }
      await settle()
    }
    await press('Backspace', 5, 150)
    await settle()
    await press('Enter', 2, 400)
    await settle()
    // A constant synthetic text; the clipboard may refuse the write outside a user gesture.
    await frame
      .locator('body')
      .evaluate(() => navigator.clipboard.writeText('pasted words'))
      .catch(() => undefined)
    await workbox.keyboard.press('Control+v')
    await settle()

    // The edited cell's text before the first Undo, kept in the page.
    await cell.evaluate((el) => {
      ;(window as unknown as { __vmdeCellBefore?: string }).__vmdeCellBefore =
        el.textContent ?? ''
    })
    await frame.locator('body').evaluate((_body, length) => {
      ;(
        window as unknown as {
          __vmdeEditCounters: { reset(length: number): void }
        }
      ).__vmdeEditCounters.reset(length as number)
    }, fixture.length)

    await press('Control+z', 1, 400)
    const firstUndoChanged = await cell.evaluate(
      (el) =>
        el.textContent !==
        (window as unknown as { __vmdeCellBefore?: string }).__vmdeCellBefore,
    )
    await press('Control+z', 2, 400)
    await press('Control+y', 3, 400)
    await settle()

    const counters = await readHistoryCounters(frame)
    console.log(
      `CELL-HISTORY-COUNTERS ${JSON.stringify({ firstUndoChanged, counters })}`,
    )
    expect(firstUndoChanged, 'the first Undo changes the cell text').toBe(true)
    expect(counters.fullGetValue).toBe(0)
    expect(counters.luteDocument).toBe(0)
    expect(counters.historyDeltaPosts).toBeGreaterThanOrEqual(1)
    expect(counters.legacyEditPosts).toBe(0)
  })
})
