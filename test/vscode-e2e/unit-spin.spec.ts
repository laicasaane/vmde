import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput, type XtestInput } from './helpers/xtest-input'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  docText,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 733 / 002 — unit spin. A key in a table cell or a bullet list item re-spins that unit alone
// instead of the whole table or list. Every case runs the same drive twice, each on its own copy of
// the fixture: once with the hook installed and once with `window.__vmdeSpinUnit` deleted (the block
// spin of today, the oracle). The saved document texts must be equal. The counters and stats are
// numbers and reason names only (no document text).

const DIR = path.join(tmpdir(), 'vmde-t733-unit-spin')
const TABLE_HEAVY = tableHeavyMarkdown(1)
const MODEL_OFF_DOC =
  'See [x][r].\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[r]: https://example.com\n'

type EvaluateInVSCode = (fn: unknown, args: unknown[]) => Promise<unknown>
type Frame = ReturnType<typeof wf>

interface Counters {
  luteTable: number
  luteList: number
}
type Stats = Record<string, number> | null

interface Place {
  selector: string
  nth: number
}
const CELL: Place = { selector: '.vditor-ir .vditor-reset > table td', nth: 7 }
const ITEM: Place = { selector: '.vditor-ir .vditor-reset > ul > li', nth: 2 }
const SMALL_CELL: Place = {
  selector: '.vditor-ir .vditor-reset > table td',
  nth: 0,
}

interface Run {
  text: string
  counters: Counters
  stats: Stats
  cellText: string
}

interface Drive {
  workbox: Page
  frame: Frame
  xtest: XtestInput | undefined
}

interface Setup {
  workbox: Page
  evaluateInVSCode: EvaluateInVSCode
  electronApp: unknown
}

const flatten = (text: string) => text.replace(/​/gu, '')

async function open(
  { workbox, evaluateInVSCode }: Setup,
  file: string,
): Promise<Frame> {
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
    { message: 'the unit-spin editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  return frame
}

async function placeCaret(
  workbox: Page,
  frame: Frame,
  place: Place,
): Promise<void> {
  const target = frame.locator(place.selector).nth(place.nth)
  await target.scrollIntoViewIfNeeded()
  await target.click()
  await workbox.keyboard.press('End')
}

const resetCounters = (frame: Frame, length: number) =>
  frame.locator('body').evaluate((_body, n) => {
    ;(
      window as unknown as { __vmdeEditCounters: { reset(n: number): void } }
    ).__vmdeEditCounters.reset(n as number)
  }, length)

const readCounters = (frame: Frame): Promise<Counters> =>
  frame.locator('body').evaluate(() => {
    const c = (window as unknown as { __vmdeEditCounters: Counters })
      .__vmdeEditCounters
    return { luteTable: c.luteTable, luteList: c.luteList }
  })

const readStats = (frame: Frame): Promise<Stats> =>
  frame.locator('body').evaluate(() => {
    const stats = (
      window as unknown as { __vmdeUnitSpinStats?: Record<string, number> }
    ).__vmdeUnitSpinStats
    return stats ? { ...stats } : null
  })

const removeHook = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    delete (window as unknown as { __vmdeSpinUnit?: unknown }).__vmdeSpinUnit
  })

/** Text of the Nth element of a place, read from the live DOM with the caret marker and zero-width characters removed. */
const placeText = (frame: Frame, place: Place): Promise<string> =>
  frame.locator('body').evaluate((_body, p) => {
    const el = document.querySelectorAll((p as Place).selector)[
      (p as Place).nth
    ]
    return (el?.textContent ?? '').replace(/​/gu, '')
  }, place)

/**
 * One drive on one copy of the document. `hook: false` removes the unit-spin hook after the editor
 * opened, so the whole block spin handles every key.
 */
async function run(
  setup: Setup,
  name: string,
  doc: string,
  hook: boolean,
  place: Place,
  drive: (d: Drive) => Promise<void>,
  needsXtest = false,
): Promise<Run> {
  const { workbox, evaluateInVSCode } = setup
  mkdirSync(DIR, { recursive: true })
  const file = path.join(DIR, `${name}-${hook ? 'hook' : 'oracle'}.md`)
  writeFileSync(file, doc)
  const frame = await open(setup, file)
  if (!hook) await removeHook(frame)
  let xtest: XtestInput | undefined
  if (needsXtest) {
    xtest = await createXtestInput(setup.electronApp as never, workbox as never)
  }
  if (xtest) {
    // The first XTEST Ctrl chord of a session sometimes never reaches the webview. It runs before the
    // counters are reset, so an Undo it may cause is not counted against the case.
    await frame.locator('.vditor-ir .vditor-reset p').first().click()
    await xtest.key('ctrl+z')
    await workbox.waitForTimeout(300)
  }
  await placeCaret(workbox, frame, place)
  await resetCounters(frame, doc.length)
  await drive({ workbox, frame, xtest })
  // The idle publication and the host answer must have run before anything is read.
  await workbox.waitForTimeout(2000)
  const counters = await readCounters(frame)
  const stats = await readStats(frame)
  const cellText = await placeText(frame, place)
  const text = flatten(await docText(evaluateInVSCode as never, file))
  rmSync(file, { force: true })
  return { text, counters, stats, cellText }
}

/** The hook run and the oracle run of one case; the document texts must be equal. */
async function both(
  setup: Setup,
  name: string,
  doc: string,
  place: Place,
  drive: (d: Drive) => Promise<void>,
  needsXtest = false,
  expectChange = true,
): Promise<{ hooked: Run; oracle: Run }> {
  const hooked = await run(setup, name, doc, true, place, drive, needsXtest)
  const oracle = await run(setup, name, doc, false, place, drive, needsXtest)
  expect(hooked.text, 'document text equals the oracle').toBe(oracle.text)
  if (expectChange)
    expect(hooked.text, 'the drive changed the document').not.toBe(flatten(doc))
  return { hooked, oracle }
}

test.describe('unit spin', () => {
  test.describe.configure({ timeout: 10 * 60_000 })

  test('cell letters and settle', async ({
    workbox,
    evaluateInVSCode,
    electronApp,
  }) => {
    const { hooked } = await both(
      { workbox, evaluateInVSCode: evaluateInVSCode as never, electronApp },
      'cell-letters',
      TABLE_HEAVY,
      CELL,
      async ({ workbox: page }) => {
        await page.keyboard.type('abc')
        await page.waitForTimeout(1000)
        await page.keyboard.type('d')
      },
    )
    expect(hooked.counters.luteTable).toBe(0)
    expect(hooked.stats?.spun ?? 0).toBeGreaterThanOrEqual(1)
  })

  test('cell Backspace and punctuation', async ({
    workbox,
    evaluateInVSCode,
    electronApp,
  }) => {
    const { hooked } = await both(
      { workbox, evaluateInVSCode: evaluateInVSCode as never, electronApp },
      'cell-backspace',
      TABLE_HEAVY,
      CELL,
      async ({ workbox: page }) => {
        await page.keyboard.press('Backspace')
        await page.keyboard.press('Backspace')
        await page.keyboard.type('.')
        await page.keyboard.type(',')
      },
    )
    expect(hooked.counters.luteTable).toBe(0)
  })

  test('pipe in a cell', async ({ workbox, evaluateInVSCode, electronApp }) => {
    const { hooked } = await both(
      { workbox, evaluateInVSCode: evaluateInVSCode as never, electronApp },
      'cell-pipe',
      TABLE_HEAVY,
      CELL,
      async ({ workbox: page }) => {
        await page.keyboard.type('|')
      },
    )
    // The block spin ran: the unit spin refused the shape and counted it.
    expect(hooked.stats?.shape ?? 0).toBeGreaterThanOrEqual(1)
  })

  test('Undo flush after typing in a cell', async ({
    workbox,
    evaluateInVSCode,
    electronApp,
  }) => {
    const { hooked } = await both(
      { workbox, evaluateInVSCode: evaluateInVSCode as never, electronApp },
      'cell-undo',
      TABLE_HEAVY,
      CELL,
      async ({ workbox: page }) => {
        await page.keyboard.type('xyz')
        // Undo at once: the pending settle re-spin is flushed by the Undo boundary.
        await page.keyboard.press('Control+z')
      },
      false,
      false,
    )
    expect(hooked.counters.luteTable).toBe(0)
  })

  test('paste into a cell', async ({
    workbox,
    evaluateInVSCode,
    electronApp,
  }) => {
    await evaluateInVSCode(
      (async (vscode: typeof import('vscode')) => {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.env.clipboard.writeText('pasted words')
      }) as never,
      [],
    )
    const { hooked } = await both(
      { workbox, evaluateInVSCode: evaluateInVSCode as never, electronApp },
      'cell-paste',
      TABLE_HEAVY,
      CELL,
      async ({ xtest }) => {
        await xtest?.key('ctrl+v')
      },
      true,
    )
    // The unit spin handled the paste (the stats name the refusal reason when it did not).
    expect(hooked.stats, 'unit spin stats after the paste').toMatchObject({
      spun: expect.any(Number),
    })
    expect(hooked.stats?.spun ?? 0).toBeGreaterThanOrEqual(1)
    expect(hooked.counters.luteTable, JSON.stringify(hooked.stats)).toBe(0)
  })

  test('list item typing', async ({
    workbox,
    evaluateInVSCode,
    electronApp,
  }) => {
    const { hooked } = await both(
      { workbox, evaluateInVSCode: evaluateInVSCode as never, electronApp },
      'item-typing',
      TABLE_HEAVY,
      ITEM,
      async ({ workbox: page }) => {
        await page.keyboard.type('ab')
        await page.keyboard.press('Backspace')
        await page.keyboard.type('.')
      },
    )
    // Item spin is on for bullet items (Q-46): no whole-list Lute call.
    expect(hooked.counters.luteList, JSON.stringify(hooked.stats)).toBe(0)
  })

  test('model off', async ({ workbox, evaluateInVSCode, electronApp }) => {
    const { hooked } = await both(
      { workbox, evaluateInVSCode: evaluateInVSCode as never, electronApp },
      'model-off',
      MODEL_OFF_DOC,
      SMALL_CELL,
      async ({ workbox: page }) => {
        await page.keyboard.type('q')
        await page.waitForTimeout(500)
      },
    )
    // A document with a definition has no live model: the hook refuses and the block spin runs.
    expect(hooked.stats?.['model-off'] ?? 0).toBeGreaterThanOrEqual(1)
  })

  test('caret stays in the cell after the settle spin', async ({
    workbox,
    evaluateInVSCode,
    electronApp,
  }) => {
    const { hooked } = await both(
      { workbox, evaluateInVSCode: evaluateInVSCode as never, electronApp },
      'cell-caret',
      TABLE_HEAVY,
      CELL,
      async ({ workbox: page }) => {
        await page.keyboard.type('ab')
        // The settle re-spin rewrites the cell; the next key must land in the same cell.
        await page.waitForTimeout(1000)
        await page.keyboard.type('c')
      },
    )
    expect(hooked.cellText.endsWith('abc')).toBe(true)
  })
})
