import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 733 / 005 — the model change feed. In an end-to-end run the webview keeps
// `window.__vmdeUnitFeedStats`: the count of changes per cause, the count of `whole` changes and the
// kinds of the last change's units. Numbers and kind names only, never document text.

const DIR = path.join(tmpdir(), 'vmde-t733-unit-feed')
const TABLE_HEAVY = tableHeavyMarkdown(1)
const CELL = '.vditor-ir .vditor-reset > table td'
const PARAGRAPH = '.vditor-ir .vditor-reset > p'

type Frame = ReturnType<typeof wf>
type EvaluateInVSCode = (fn: unknown, args: string[]) => Promise<unknown>

interface FeedStats {
  mutation: number
  sync: number
  build: number
  rebind: number
  whole: number
  lastKinds: string[]
}

const readStats = (frame: Frame): Promise<FeedStats> =>
  frame.locator('body').evaluate(() => {
    const stats = (window as unknown as { __vmdeUnitFeedStats?: FeedStats })
      .__vmdeUnitFeedStats
    if (!stats) throw new Error('no __vmdeUnitFeedStats (not an e2e run?)')
    return { ...stats, lastKinds: [...stats.lastKinds] }
  })

async function open(
  workbox: Page,
  evaluateInVSCode: EvaluateInVSCode,
  name: string,
): Promise<{ frame: Frame; file: string }> {
  mkdirSync(DIR, { recursive: true })
  const file = path.join(DIR, `${name}.md`)
  writeFileSync(file, TABLE_HEAVY)
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
    { message: 'the unit-feed editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  // The model is built (a `build` change was counted) before any case drives the editor.
  await expect
    .poll(async () => (await readStats(frame)).build, {
      timeout: 60_000,
      message: 'the model built and the feed counted the build',
    })
    .toBeGreaterThanOrEqual(1)
  return { frame, file }
}

test.afterEach(async ({ evaluateInVSCode }) => {
  await (evaluateInVSCode as EvaluateInVSCode)(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    },
    [],
  )
  rmSync(DIR, { recursive: true, force: true })
})

test.describe('unit feed', () => {
  test.describe.configure({ timeout: 5 * 60_000 })

  test('cell typing reports the cell, not a whole change', async ({
    workbox,
    evaluateInVSCode,
  }) => {
    const { frame } = await open(
      workbox,
      evaluateInVSCode as EvaluateInVSCode,
      'cell',
    )
    const target = frame.locator(CELL).nth(7)
    await target.scrollIntoViewIfNeeded()
    await target.click()
    await workbox.keyboard.press('End')
    const before = await readStats(frame)
    await workbox.keyboard.type('ab')
    // The snapshot is taken in one evaluate call at the first moment a mutation change is counted.
    const after = await expect
      .poll(
        async () => {
          const stats = await readStats(frame)
          return stats.mutation > before.mutation ? stats : null
        },
        { timeout: 30_000, message: 'a mutation change was counted' },
      )
      .not.toBeNull()
      .then(() => readStats(frame))
    expect(after.lastKinds).toEqual(['cell'])
    expect(after.whole, 'no whole change for a cell edit').toBe(before.whole)
  })

  test('Enter in a paragraph counts a whole change', async ({
    workbox,
    evaluateInVSCode,
  }) => {
    const { frame } = await open(
      workbox,
      evaluateInVSCode as EvaluateInVSCode,
      'enter',
    )
    const target = frame.locator(PARAGRAPH).nth(2)
    await target.scrollIntoViewIfNeeded()
    await target.click()
    await workbox.keyboard.press('End')
    const before = await readStats(frame)
    await workbox.keyboard.press('Enter')
    await expect
      .poll(async () => (await readStats(frame)).whole, {
        timeout: 30_000,
        message: 'a whole change was counted',
      })
      .toBeGreaterThan(before.whole)
  })

  test('typing in Source mode counts no change', async ({
    workbox,
    evaluateInVSCode,
  }) => {
    const { frame } = await open(
      workbox,
      evaluateInVSCode as EvaluateInVSCode,
      'source',
    )
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator('button[data-mode="sv"]').click()
    const editor = frame.locator('.vditor-sv').first()
    await editor.waitFor({ timeout: 30_000 })
    // Leaving IR may settle the model; the baseline is read after it did.
    await workbox.waitForTimeout(1500)
    const before = await readStats(frame)
    await editor.click()
    await workbox.keyboard.type('xy')
    await workbox.waitForTimeout(2000)
    expect(await readStats(frame)).toEqual(before)
  })
})
