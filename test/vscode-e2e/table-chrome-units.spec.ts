import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 733 / 007: table chrome (responsive widths, resize handles, the cell click panel) works from
// the changed cells of the unit feed. Numbers and booleans only; no document text is logged.

type Page = import('@playwright/test').Page
type Frame = ReturnType<typeof wf>

const fixture = tableHeavyMarkdown(1)
const TABLES = '.vditor-ir .vditor-reset > table:not(.vmde-front-matter)'
const TABLE_A_CELL = 7
const TABLE_B_CELL = 3
// Cell 3 of the five-column table B is in its fourth column.
const TABLE_B_COLUMN = (TABLE_B_CELL % 5) + 1
// The width engine holds a table for 600 ms after its last edit; 1 s covers the hold and the flush.
const SETTLE_MS = 1000

async function openFixture(
  evaluateInVSCode: (fn: unknown, args: string[]) => Promise<unknown>,
  workbox: Page,
  baseDir: string,
  name: string,
): Promise<Frame> {
  const file = path.join(baseDir, `${name}.md`)
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
    { message: 'the table chrome editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  // Let the first measurement of every near table finish before a case reads or counts.
  await workbox.waitForTimeout(SETTLE_MS)
  return frame
}

const resetCounters = (frame: Frame) =>
  frame.locator('body').evaluate((_body, length) => {
    ;(
      window as unknown as {
        __vmdeEditCounters: { reset(length: number): void }
      }
    ).__vmdeEditCounters.reset(length as number)
  }, fixture.length)

const tableClones = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __vmdeEditCounters: { tableClone: number } })
          .__vmdeEditCounters.tableClone,
    )

/** The width rule text of a table (its automatic class in the head style), '' when it has none. */
const widthRule = (frame: Frame, table: number) =>
  frame.locator('body').evaluate((_body, index) => {
    const el = document.querySelectorAll(
      '.vditor-ir .vditor-reset > table:not(.vmde-front-matter)',
    )[index as number]
    const name = Array.from(el?.classList ?? []).find((c) =>
      c.startsWith('vmde-table-auto-'),
    )
    if (!name) return ''
    return Array.from(document.head.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .filter((text) => text.includes(`table.${name} `))
      .join('\n')
  }, table)

/** The width in px of the 1-based `column` of a rule text, NaN when absent. */
const columnWidth = (rule: string, column: number) =>
  Number(
    new RegExp(`nth-child\\(${column}\\) \\{[^}]*?width: ([0-9.]+)px`).exec(
      rule,
    )?.[1],
  )

/**
 * Scrolls the cell near, waits for the first measurement of the tables that scrolled near (the
 * counters and the rules are read after it), then puts the caret at the end of the cell.
 */
async function clickCell(
  workbox: Page,
  frame: Frame,
  table: number,
  nth: number,
) {
  const cell = frame.locator(TABLES).nth(table).locator('td').nth(nth)
  await cell.scrollIntoViewIfNeeded()
  await workbox.waitForTimeout(SETTLE_MS)
  await cell.click()
  await workbox.keyboard.press('End')
  await workbox.waitForTimeout(SETTLE_MS)
}

/** Collects uncaught errors and `console.error` calls of the webview from now on. */
const watchWebviewErrors = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const errors: string[] = []
    ;(window as unknown as { __chromeErrors: string[] }).__chromeErrors = errors
    window.addEventListener('error', () => errors.push('error'))
    window.addEventListener('unhandledrejection', () =>
      errors.push('rejection'),
    )
    const original = console.error
    console.error = (...args: unknown[]) => {
      errors.push('console.error')
      original.apply(console, args)
    }
  })

const webviewErrors = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __chromeErrors?: string[] }).__chromeErrors ??
        [],
    )

test.describe('table chrome on units', () => {
  test('typing keeps widths: no table clone and an unchanged column rule', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(
      evaluateInVSCode,
      workbox,
      baseDir,
      'table-chrome-typing',
    )
    await clickCell(workbox, frame, 0, TABLE_A_CELL)
    const before = await widthRule(frame, 0)
    expect(before.length).toBeGreaterThan(0)
    await resetCounters(frame)
    for (const ch of 'ab') {
      await workbox.keyboard.press(ch)
      await workbox.waitForTimeout(80)
    }
    await workbox.waitForTimeout(SETTLE_MS)
    const clones = await tableClones(frame)
    console.log(`TABLE-CHROME ${JSON.stringify({ case: 'typing', clones })}`)
    expect(clones).toBe(0)
    expect(await widthRule(frame, 0)).toBe(before)
  })

  test('wide content widens its column from the cell alone, with no table clone', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(
      evaluateInVSCode,
      workbox,
      baseDir,
      'table-chrome-wide',
    )
    // Table B: table A holds a 600-character cell, which pins every column to the same share.
    await clickCell(workbox, frame, 1, TABLE_B_CELL)
    const before = columnWidth(await widthRule(frame, 1), TABLE_B_COLUMN)
    await resetCounters(frame)
    // Long text with breakable words: a wide max-content, a small min-content.
    await workbox.keyboard.type(
      'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor',
    )
    await workbox.waitForTimeout(SETTLE_MS)
    const clones = await tableClones(frame)
    const after = columnWidth(await widthRule(frame, 1), TABLE_B_COLUMN)
    console.log(
      `TABLE-CHROME ${JSON.stringify({ case: 'wide', clones, before, after })}`,
    )
    // Q-54: a changed cell is measured alone, never as a table clone.
    expect(clones).toBe(0)
    expect(Number.isFinite(before)).toBe(true)
    // The cell sits in the fourth column of table B.
    expect(after).toBeGreaterThan(before)
  })

  test('a row insert recomputes the widths as before', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(
      evaluateInVSCode,
      workbox,
      baseDir,
      'table-chrome-row',
    )
    await clickCell(workbox, frame, 0, TABLE_A_CELL)
    const rowsBefore = await frame.locator(TABLES).nth(0).locator('tr').count()
    await resetCounters(frame)
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('vmde.table.insertRowBelow')
    }, [])
    await workbox.waitForTimeout(SETTLE_MS)
    const rowsAfter = await frame.locator(TABLES).nth(0).locator('tr').count()
    const rule = await widthRule(frame, 0)
    // A structural change keeps today's full pass: the table is measured again (a table clone).
    const clones = await tableClones(frame)
    console.log(
      `TABLE-CHROME ${JSON.stringify({ case: 'row', rowsBefore, rowsAfter, clones, rule: rule.length > 0 })}`,
    )
    expect(rowsAfter).toBe(rowsBefore + 1)
    expect(clones).toBeGreaterThanOrEqual(1)
    // The rule exists and selects by column position, so it covers the new row.
    expect(Number.isFinite(columnWidth(rule, 1))).toBe(true)
  })

  test('a click into table B shows the table panel for table B after the next frame', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(
      evaluateInVSCode,
      workbox,
      baseDir,
      'table-chrome-panel',
    )
    await frame.locator(TABLES).nth(1).locator('td').nth(TABLE_B_CELL).click()
    await frame
      .locator('body')
      .evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
    const state = await frame.locator('body').evaluate(() => {
      const panel = document.querySelector<HTMLElement>(
        '#fix-table-ir-wrapper .vditor-panel',
      )
      const tables = Array.from(
        document.querySelectorAll(
          '.vditor-ir .vditor-reset > table:not(.vmde-front-matter)',
        ),
      )
      const anchor = window.getSelection()?.anchorNode
      const owner = (
        anchor instanceof Element ? anchor : anchor?.parentElement
      )?.closest('table')
      // The panel's side: it sits just above the caret cell of table B, not near table A.
      const panelTop = panel?.getBoundingClientRect().top ?? Number.NaN
      const cellTop =
        owner?.querySelectorAll('td')[3]?.getBoundingClientRect().top ??
        Number.NaN
      return {
        shown: panel?.style.display === 'block',
        tableIndex: owner ? tables.indexOf(owner) : -1,
        panelNearCell: Math.abs(panelTop - cellTop) <= 80,
      }
    })
    console.log(`TABLE-CHROME ${JSON.stringify({ case: 'panel', ...state })}`)
    expect(state.shown).toBe(true)
    expect(state.tableIndex).toBe(1)
    expect(state.panelNearCell).toBe(true)
  })

  test('Source and back to IR: typing in a cell behaves as before, without console errors', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(
      evaluateInVSCode,
      workbox,
      baseDir,
      'table-chrome-source',
    )
    await watchWebviewErrors(frame)
    const switchMode = async (mode: 'ir' | 'sv') => {
      await frame.locator('body').evaluate((_body, next) => {
        const inner = (window as any).vditor.vditor
        if (inner.currentMode === next) return
        inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
        document
          .querySelector(`button[data-mode="${next}"]`)
          ?.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }),
          )
      }, mode)
      await expect
        .poll(() =>
          frame
            .locator('body')
            .evaluate(() => (window as any).vditor.vditor.currentMode),
        )
        .toBe(mode)
    }
    await switchMode('sv')
    await switchMode('ir')
    await waitForE2EReadiness(frame, (snapshot) => snapshot.mode === 'ir', {
      message: 'IR is ready again after the Source round trip',
    })
    await workbox.waitForTimeout(SETTLE_MS)
    await clickCell(workbox, frame, 0, TABLE_A_CELL)
    await resetCounters(frame)
    for (const ch of 'ab') {
      await workbox.keyboard.press(ch)
      await workbox.waitForTimeout(80)
    }
    await workbox.waitForTimeout(SETTLE_MS)
    const clones = await tableClones(frame)
    const errors = await webviewErrors(frame)
    console.log(
      `TABLE-CHROME ${JSON.stringify({ case: 'source', clones, errors: errors.length })}`,
    )
    // The contract asks for today's behaviour and a clean console: the rebind after the mode switch
    // is a whole change, which keeps its full pass (a measurement), so no clone count is asserted.
    expect(errors).toEqual([])
    // The widths are still applied to the table.
    expect((await widthRule(frame, 0)).length).toBeGreaterThan(0)
  })
})
