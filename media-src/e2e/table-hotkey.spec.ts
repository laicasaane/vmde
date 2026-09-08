import { test, expect } from './coverage-fixture'
import type { Page } from '@playwright/test'
import type { TableAction } from '../src/editing/table-hotkey'

const _SEED = '| a | b |\n| - | - |\n| 1 | 2 |\n'

async function gotoEditor(page: Page) {
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__ready === true)
}

function getValue(page: Page) {
  return page.evaluate(() => (window as any).vditorTest.getValue() as string)
}

// place the caret in the first data cell so a table hotkey has cell context
async function selectFirstCell(page: Page) {
  await page.locator('.vditor-ir td').first().click()
  await page.waitForTimeout(100)
}

type Parsed = { cols: number; bodyRows: number; separator: string }
function parseTable(md: string): Parsed {
  const lines = md
    .trim()
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
  const cols = (lines[0]?.match(/\|/g)?.length ?? 1) - 1
  return {
    cols,
    bodyRows: Math.max(0, lines.length - 2),
    separator: lines[1] ?? '',
  }
}

// expected effect of each action relative to the seed table
const CHECKS: Record<TableAction, (before: Parsed, after: Parsed) => void> = {
  left: (_b, a) => expect(a.separator).toMatch(/:-(?!:)/),
  center: (_b, a) => expect(a.separator).toMatch(/:-+:/),
  right: (_b, a) => expect(a.separator).toMatch(/-:/),
  insertRowA: (b, a) => expect(a.bodyRows).toBe(b.bodyRows + 1),
  insertRowB: (b, a) => expect(a.bodyRows).toBe(b.bodyRows + 1),
  deleteRow: (b, a) => expect(a.bodyRows).toBe(b.bodyRows - 1),
  insertColumnL: (b, a) => expect(a.cols).toBe(b.cols + 1),
  insertColumnR: (b, a) => expect(a.cols).toBe(b.cols + 1),
  deleteColumn: (b, a) => expect(a.cols).toBe(b.cols - 1),
}

const ACTIONS = Object.keys(CHECKS) as TableAction[]

test.describe('dispatch-level: dispatchTableHotkey triggers the Vditor action', () => {
  for (const action of ACTIONS) {
    test(action, async ({ page }) => {
      await gotoEditor(page)
      const before = parseTable(await getValue(page))
      await selectFirstCell(page)
      await page.evaluate(
        (a) => (window as any).__dispatchTableHotkey(a),
        action,
      )
      await page.waitForTimeout(100)
      const after = parseTable(await getValue(page))
      CHECKS[action](before, after)
    })
  }
})

test('panel appears horizontally aligned with the clicked cell, not pinned far left', async ({
  page,
}) => {
  await gotoEditor(page)
  // click the second-column data cell, which sits well to the right
  await page.locator('.vditor-ir td').nth(1).click()
  await page.waitForTimeout(120)
  const { panelLeft, cellLeft } = await page.evaluate(() => {
    const cell = (window as any).vditor.vditor.ir.element.querySelectorAll(
      'td',
    )[1] as HTMLElement
    const panel = document
      .getElementById('fix-table-ir-wrapper')!
      .querySelector('.vditor-panel') as HTMLElement
    return {
      panelLeft: panel.getBoundingClientRect().left,
      cellLeft: cell.getBoundingClientRect().left,
    }
  })
  expect(Math.abs(panelLeft - cellLeft)).toBeLessThan(30)
})

test('clicking a non-table paragraph reserves no flow space (no editing gap)', async ({
  page,
}) => {
  await gotoEditor(page)
  await page.evaluate(() => {
    ;(window as any).vditor.setValue(
      'A paragraph.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nTail paragraph.\n',
    )
  })
  await page.waitForTimeout(120)
  // click into the plain paragraph — this creates the table-panel wrapper, whose
  // inner panel stays hidden (not a cell). The wrapper must NOT add an empty box
  // to the content flow (regression: a static wrapper reserved a ~58px line +
  // margin, showing as a gap under the text while editing).
  await page.locator('.vditor-ir p').first().click()
  await page.waitForTimeout(80)
  const got = await page.evaluate(() => {
    const w = document.getElementById('fix-table-ir-wrapper')!
    const panel = w.querySelector('.vditor-panel') as HTMLElement
    return {
      position: getComputedStyle(w).position,
      wrapperHeight: Math.round(w.getBoundingClientRect().height),
      panelDisplay: panel.style.display,
    }
  })
  expect(got.position).toBe('absolute') // taken out of the content flow
  expect(got.wrapperHeight).toBe(0) // reserves no vertical space → no gap
  expect(got.panelDisplay).toBe('none') // panel hidden for a non-cell click
})

test('table panel shows for a cell containing only inline code', async ({
  page,
}) => {
  await gotoEditor(page)
  // A table whose first cell is only inline code — the caret lands inside the
  // <code> span, not the cell, which used to hide the panel.
  await page.evaluate(() => {
    ;(window as any).vditor.setValue(
      '| `a/b/*.spec.ts` | x |\n| - | - |\n| 1 | 2 |\n',
    )
  })
  await page.waitForTimeout(100)
  await page.locator('.vditor-ir code').first().click()
  await page.waitForTimeout(100)
  const display = await page.evaluate(() => {
    const panel = document.querySelector(
      '#fix-table-ir-wrapper .vditor-panel',
    ) as HTMLElement | null
    return panel?.style.display
  })
  expect(display).toBe('block')
})

test('the table panel is excluded from the editable region', async ({
  page,
}) => {
  await gotoEditor(page)
  await page.locator('.vditor-ir td').nth(0).click()
  await page.waitForTimeout(120)
  const props = await page.evaluate(() => {
    const el = document.getElementById('fix-table-ir-wrapper')!
    return {
      contentEditable: el.contentEditable,
      userSelect: el.style.userSelect,
    }
  })
  expect(props.contentEditable).toBe('false')
  expect(props.userSelect).toBe('none')
})

test('dragging across cells paints a serializer-invisible rectangle', async ({
  page,
}) => {
  await gotoEditor(page)
  const cells = page.locator('.vditor-ir td')
  const before = await getValue(page)
  const start = await cells.nth(0).boundingBox()
  const end = await cells.nth(1).boundingBox()
  if (!start || !end) throw new Error('table cells were not visible')
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2)
  await page.mouse.up()

  await expect(page.locator('.vditor-ir .vmde-cell-selected')).toHaveCount(2)
  expect(await getValue(page)).toBe(before)
})

test('rectangle copy keeps rendered TSV separate from raw inline Markdown', async ({
  page,
}) => {
  await gotoEditor(page)
  await page.evaluate(() => {
    ;(window as any).vditor.setValue(
      '| h1 | h2 |\n| --- | --- |\n| *one* | `two` |\n',
    )
  })
  await page.locator('.vditor-ir td').first().click()
  const copied = await page.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    const values: Record<string, string> = {}
    const copy = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(copy, 'clipboardData', {
      value: {
        setData: (type: string, value: string) => (values[type] = value),
      },
    })
    root.dispatchEvent(copy)
    return values
  })
  expect(copied['text/plain']).toBe('one\ttwo')
  expect(copied['text/markdown']).toBe('| *one* | `two` |\n|---|---|')
})

test('range panel insertion adds the selected column span in one transaction', async ({
  page,
}) => {
  await gotoEditor(page)
  const cells = page.locator('.vditor-ir td')
  const start = await cells.nth(0).boundingBox()
  const end = await cells.nth(1).boundingBox()
  if (!start || !end) throw new Error('table cells were not visible')
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2)
  await page.mouse.up()
  await expect(page.locator('.vditor-ir .vmde-cell-selected')).toHaveCount(2)
  await page.locator('#fix-table-ir-wrapper .vditor-panel').hover()
  await page
    .locator('#fix-table-ir-wrapper .vditor-icon[data-type="insertColumnR"]')
    .click()
  await page.waitForTimeout(100)
  expect(parseTable(await getValue(page)).cols).toBe(4)
})

test('the Move column left panel control commits one source-table transaction', async ({
  page,
}) => {
  await gotoEditor(page)
  const before = await getValue(page)
  await page.locator('.vditor-ir td').nth(1).click()
  await page.locator('#fix-table-ir-wrapper .vditor-panel').hover()
  await page
    .locator('#fix-table-ir-wrapper .vditor-icon[data-type="moveColumnLeft"]')
    .click()
  await page.waitForTimeout(100)
  const after = await getValue(page)
  expect(after).toBe(
    '| Header Two | Header One |\n| ---------- | ---------- |\n| value two  | value one  |\n',
  )
  expect(after).not.toBe(before)
})

test('IR move hotkeys use their shifted key values without stealing Shift+Arrow', async ({
  page,
}) => {
  await gotoEditor(page)
  await page.locator('.vditor-ir td').nth(1).click()
  const moved = await page.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const event = new KeyboardEvent('keydown', {
      key: '[',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    root.dispatchEvent(event)
    return {
      prevented: event.defaultPrevented,
      value: (window as any).vditor.getValue(),
    }
  })
  expect(moved.prevented).toBe(true)
  expect(moved.value).toContain('| Header Two | Header One |')
})

test('table controls disable invalid edge and destructive last-column operations', async ({
  page,
}) => {
  await gotoEditor(page)
  await page.evaluate(() => {
    ;(window as any).vditor.setValue('| only |\n| --- |\n| value |\n')
  })
  await page.locator('.vditor-ir td').first().click()
  await page.locator('#fix-table-ir-wrapper .vditor-panel').hover()
  await expect(
    page.locator('#fix-table-ir-wrapper [data-type="moveColumnLeft"]'),
  ).toBeDisabled()
  await expect(
    page.locator('#fix-table-ir-wrapper [data-type="moveColumnRight"]'),
  ).toBeDisabled()
  await expect(
    page.locator('#fix-table-ir-wrapper [data-type="deleteColumn"]'),
  ).toBeDisabled()
  await expect(
    page.locator('#fix-table-ir-wrapper [data-type="moveRowUp"]'),
  ).toBeDisabled()
})

test('ordinary WYSIWYG insert-column control expands the full rectangle span', async ({
  page,
}) => {
  await gotoEditor(page)
  await page.evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.locator('.vditor-wysiwyg td').first().waitFor()
  await page.locator('.vditor-wysiwyg td').first().click()
  await page.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.wysiwyg.element as HTMLElement
    const cells = root.querySelectorAll<HTMLTableCellElement>('td')
    const range = document.createRange()
    range.selectNodeContents(cells[0])
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    document.dispatchEvent(new Event('selectionchange'))
  })
  await expect(page.locator('.vditor-wysiwyg .vmde-cell-selected')).toHaveCount(
    2,
  )
  await page
    .locator('.vditor-wysiwyg > .vditor-panel button[data-type="insertColumn"]')
    .nth(1)
    .click()
  await page.waitForTimeout(100)
  expect(parseTable(await getValue(page)).cols).toBe(4)
})

test.describe('icon click: full flow through the table panel', () => {
  for (const action of ACTIONS) {
    test(action, async ({ page }) => {
      await gotoEditor(page)
      const before = parseTable(await getValue(page))
      await selectFirstCell(page) // reveals the collapsed "..." panel
      // hover expands the panel from "..." to the full icon row
      await page.locator('#fix-table-ir-wrapper .vditor-panel').hover()
      await page
        .locator(`#fix-table-ir-wrapper .vditor-icon[data-type="${action}"]`)
        .click()
      await page.waitForTimeout(100)
      const after = parseTable(await getValue(page))
      CHECKS[action](before, after)
    })
  }
})
