// Task 639 S2b — content-aware table column widths in the Chromium harness.
//
// Expected numbers come from the task contract and the recorded equal-width baseline of the
// fixture (table "Mixed": 665 px high in IR and WYSIWYG, 692.56 px in Preview, at a 1280 px
// viewport), never from the implementation.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

const FIXTURE = readFileSync(
  path.join(__dirname, 'fixtures/table-widths.md'),
  'utf8',
)

// The class is the only thing the engine adds to a table; its rules live in a head style element.
const AUTO_CLASS = /vmde-table-auto-\d+/u
const AUTO_WAIT = { timeout: 8000 }

type Mode = 'ir' | 'wysiwyg' | 'preview'
const SURFACE: Record<Mode, string> = {
  ir: '.vditor-ir .vditor-reset',
  wysiwyg: '.vditor-wysiwyg .vditor-reset',
  preview: '.vditor-preview .vditor-reset',
}
// Equal-width baseline heights of the "Mixed" table at 1280 px; the target is >= 25% lower.
const BASELINE_HEIGHT: Record<Mode, number> = {
  ir: 665,
  wysiwyg: 665,
  preview: 692.56,
}
// Equal-width baseline heights of the over-wide table at 1280 px: it keeps today's layout.
const BASELINE_WIDE_HEIGHT: Record<Mode, number> = {
  ir: 190,
  wysiwyg: 190,
  preview: 195.91,
}
const TABLE_MIXED = 0
const TABLE_SIMILAR = 1
const TABLE_WIDE = 2

// The harness page clips its body, so the three fixture tables must fit the viewport to be near it.
async function boot(page: Page, width = 1280, source = FIXTURE, height = 1600) {
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate((s) => (window as any).vditor.setValue(s), source)
  await page.locator('.vditor-ir table').first().waitFor()
}

// The shipped webview gives the editor the window height, so the edit surface is the scroller.
// The default harness page lets the surface grow with its content and clips it with the body.
async function constrainLayout(page: Page) {
  await page.addStyleTag({
    content:
      'html, body, #app { height: 100%; } .vditor { height: 100% !important; }',
  })
}

async function toWysiwyg(page: Page) {
  await page.evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.locator('.vditor-wysiwyg table').first().waitFor()
}

async function toPreview(page: Page) {
  await page.evaluate(() => {
    const v = (window as any).vditor.vditor
    v.preview.element.style.display = 'block'
    v[v.currentMode].element.parentElement.style.display = 'none'
    v.preview.render(v)
  })
  await page.locator('.vditor-preview table').first().waitFor()
}

async function enterMode(page: Page, mode: Mode) {
  if (mode === 'wysiwyg') await toWysiwyg(page)
  if (mode === 'preview') await toPreview(page)
}

async function waitForAuto(page: Page, mode: Mode, index: number) {
  await page.waitForFunction(
    ([selector, position, pattern]) =>
      new RegExp(pattern as string, 'u').test(
        document
          .querySelectorAll(`${selector} table`)
          [position as number]?.getAttribute('class') ?? '',
      ),
    [SURFACE[mode], index, AUTO_CLASS.source],
    AUTO_WAIT,
  )
}

interface TableMetrics {
  widths: number[]
  height: number
  width: number
  overflowTable: number
  overflowParent: number
  overflowSurface: number
}

function metrics(page: Page, mode: Mode, index: number): Promise<TableMetrics> {
  return page.evaluate(
    ([surfaceSelector, position]) => {
      const surface = document.querySelector(
        surfaceSelector as string,
      ) as HTMLElement
      const table = surface.querySelectorAll('table')[
        position as number
      ] as HTMLTableElement
      const parent = table.parentElement as HTMLElement
      const rect = table.getBoundingClientRect()
      return {
        widths: Array.from(
          table.rows[0].cells,
          (cell) => cell.getBoundingClientRect().width,
        ),
        height: rect.height,
        width: rect.width,
        overflowTable: table.scrollWidth - table.clientWidth,
        overflowParent: parent.scrollWidth - parent.clientWidth,
        overflowSurface: surface.scrollWidth - surface.clientWidth,
      }
    },
    [SURFACE[mode], index] as const,
  )
}

/** Number of text lines (distinct client-rect tops) a cell renders. */
function lineCounts(
  page: Page,
  mode: Mode,
  index: number,
  columns: number[],
): Promise<number[]> {
  return page.evaluate(
    ([surfaceSelector, position, wanted]) => {
      const table = document
        .querySelector(surfaceSelector as string)!
        .querySelectorAll('table')[position as number] as HTMLTableElement
      const counts: number[] = []
      for (const column of wanted as number[])
        for (const row of Array.from(table.rows)) {
          const range = document.createRange()
          range.selectNodeContents(row.cells[column])
          const tops = new Set(
            Array.from(range.getClientRects())
              .filter((rect) => rect.width > 0 && rect.height > 0)
              .map((rect) => Math.round(rect.top / 4)),
          )
          counts.push(tops.size)
        }
      return counts
    },
    [SURFACE[mode], index, columns] as const,
  )
}

const getValue = (page: Page): Promise<string> =>
  page.evaluate(() => (window as any).vditor.getValue() as string)

for (const mode of ['ir', 'wysiwyg', 'preview'] as const) {
  test.describe(`${mode} auto widths`, () => {
    test('a mixed table is at least 25% shorter than equal widths and keeps short columns on one line', async ({
      page,
    }) => {
      await boot(page)
      await enterMode(page, mode)
      const before = await getValue(page)
      await waitForAuto(page, mode, TABLE_MIXED)
      const mixed = await metrics(page, mode, TABLE_MIXED)
      expect(mixed.height).toBeLessThanOrEqual(BASELINE_HEIGHT[mode] * 0.75)
      // ID, status and date columns hold short values: one line in every row.
      const lines = await lineCounts(page, mode, TABLE_MIXED, [0, 1, 2])
      expect(lines.every((count) => count === 1)).toBe(true)
      // The table still fills its width and the widths are content driven, not equal.
      expect(
        Math.max(...mixed.widths) / Math.min(...mixed.widths),
      ).toBeGreaterThan(2)
      expect(
        Math.abs(
          mixed.widths.reduce((sum, width) => sum + width, 0) - mixed.width,
        ),
      ).toBeLessThanOrEqual(1)
      // View-only: no markdown change, nothing in the editable DOM except the class.
      expect(await getValue(page)).toBe(before)
      const dom = await page.evaluate((selector) => {
        const table = document
          .querySelector(selector)!
          .querySelectorAll('table')[0] as HTMLTableElement
        return {
          colgroup: table.querySelector('colgroup') !== null,
          inlineCellWidth: Array.from(table.querySelectorAll('th, td')).some(
            (cell) => (cell as HTMLElement).style.width !== '',
          ),
        }
      }, SURFACE[mode])
      expect(dom).toEqual({ colgroup: false, inlineCellWidth: false })
    })

    test('a table of similar columns stays roughly equal', async ({ page }) => {
      await boot(page)
      await enterMode(page, mode)
      await waitForAuto(page, mode, TABLE_SIMILAR)
      const similar = await metrics(page, mode, TABLE_SIMILAR)
      expect(
        Math.max(...similar.widths) / Math.min(...similar.widths),
      ).toBeLessThanOrEqual(1.15)
    })

    test('an over-wide table keeps its equal-width layout and gains no horizontal scroll', async ({
      page,
    }) => {
      await boot(page)
      await enterMode(page, mode)
      await waitForAuto(page, mode, TABLE_WIDE)
      const wide = await metrics(page, mode, TABLE_WIDE)
      expect(wide.overflowTable).toBeLessThanOrEqual(0)
      expect(wide.overflowParent).toBeLessThanOrEqual(0)
      expect(wide.overflowSurface).toBeLessThanOrEqual(0)
      // No regression against today's layout: same height, near-equal columns.
      expect(
        Math.abs(wide.height - BASELINE_WIDE_HEIGHT[mode]),
      ).toBeLessThanOrEqual(1)
      expect(
        Math.max(...wide.widths) - Math.min(...wide.widths),
      ).toBeLessThanOrEqual(2)
      expect(
        Math.abs(
          wide.widths.reduce((sum, width) => sum + width, 0) - wide.width,
        ),
      ).toBeLessThanOrEqual(1)
    })
  })
}

test('handles line up with the automatic widths and a manual resize beats them', async ({
  page,
}) => {
  await boot(page)
  await waitForAuto(page, 'ir', TABLE_MIXED)
  const handleError = () =>
    page.evaluate(() => {
      const table = document.querySelectorAll('.vditor-ir table')[0]
      const handles = Array.from(
        document.querySelectorAll<HTMLElement>('.vmde-table-resize-handle'),
      ).slice(0, 5)
      return Array.from(table.querySelectorAll('th')).map((cell, index) => {
        const handle = handles[index].getBoundingClientRect()
        return Math.abs(
          cell.getBoundingClientRect().right - (handle.left + handle.width / 2),
        )
      })
    })
  await expect
    .poll(async () => Math.max(...(await handleError())))
    .toBeLessThan(3)

  const auto = await metrics(page, 'ir', TABLE_MIXED)
  const handle = page.locator('.vmde-table-resize-handle').first()
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2)
  await page.mouse.up()

  await expect
    .poll(
      async () =>
        (await page.evaluate(() =>
          document
            .querySelectorAll('.vditor-ir table')[0]
            .getAttribute('class'),
        )) ?? '',
    )
    .toContain('vmde-table-resized')
  const resized = await page.evaluate(
    () => document.querySelectorAll('.vditor-ir table')[0].className,
  )
  expect(resized).not.toMatch(AUTO_CLASS)
  const after = await metrics(page, 'ir', TABLE_MIXED)
  // The drag starts from the automatic widths: only the dragged column moves.
  expect(Math.abs(after.widths[0] - (auto.widths[0] + 60))).toBeLessThanOrEqual(
    2,
  )
  for (let column = 1; column < auto.widths.length; column++)
    expect(
      Math.abs(after.widths[column] - auto.widths[column]),
    ).toBeLessThanOrEqual(1)
  await expect
    .poll(async () => Math.max(...(await handleError())))
    .toBeLessThan(3)

  // A later recompute trigger (a width change) leaves the session widths alone.
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.waitForTimeout(800)
  const stillResized = await page.evaluate(
    () => document.querySelectorAll('.vditor-ir table')[0].className,
  )
  expect(stillResized).toContain('vmde-table-resized')
  expect(stillResized).not.toMatch(AUTO_CLASS)
  const later = await metrics(page, 'ir', TABLE_MIXED)
  for (let column = 0; column < after.widths.length; column++)
    expect(
      Math.abs(later.widths[column] - after.widths[column]),
    ).toBeLessThanOrEqual(1)
})

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: widths hold across ten keystrokes and settle once after the pause`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await boot(page)
    await enterMode(page, mode)
    await waitForAuto(page, mode, TABLE_MIXED)
    const selector = `${SURFACE[mode]} table`
    const before = await getValue(page)
    const initial = await metrics(page, mode, TABLE_MIXED)

    // Log every frame whose first-row widths differ by >= 1 px from the previous logged frame.
    await page.evaluate((tableSelector) => {
      const log: Array<{ time: number; widths: number[] }> = []
      let previous: number[] | null = null
      const tick = () => {
        const table = document.querySelector(
          tableSelector,
        ) as HTMLTableElement | null
        if (table) {
          const widths = Array.from(
            table.rows[0].cells,
            (cell) => cell.getBoundingClientRect().width,
          )
          if (
            !previous ||
            widths.length !== previous.length ||
            widths.some((width, i) => Math.abs(width - previous![i]) >= 1)
          ) {
            log.push({ time: performance.now(), widths })
            previous = widths
          }
        }
        requestAnimationFrame(tick)
      }
      ;(window as any).__widthLog = log
      tick()
    }, selector)

    // Click the status cell of the first body row, caret to its end, and type a long word.
    const cell = page.locator(selector).first().locator('tbody td').nth(1)
    await cell.click()
    await page.keyboard.press('End')
    await page.evaluate(() => {
      ;(window as any).__widthLog.length = 0
    })
    const typed = 'abcdefghij'
    for (const letter of typed) {
      await page.keyboard.type(letter, { delay: 20 })
      const widths = await page.evaluate((tableSelector) => {
        const table = document.querySelector(tableSelector) as HTMLTableElement
        return Array.from(
          table.rows[0].cells,
          (c) => c.getBoundingClientRect().width,
        )
      }, selector)
      // No flash back to equal widths and no per-keystroke drift.
      for (const [column, width] of widths.entries())
        expect(Math.abs(width - initial.widths[column])).toBeLessThanOrEqual(2)
    }
    const typingEnd = await page.evaluate(() => performance.now())
    // Vditor pads table columns when it serializes, so compare with the padding collapsed.
    const collapse = (markdown: string) =>
      markdown.replace(/ +/gu, ' ').replace(/-+/gu, '-')
    expect(
      collapse(await getValue(page)),
      'typing must edit exactly the typed cell',
    ).toBe(
      collapse(before).replace('| T-101 | Open |', `| T-101 | Open${typed} |`),
    )

    await page.waitForTimeout(1500)
    const log = await page.evaluate(
      () =>
        (window as any).__widthLog as Array<{ time: number; widths: number[] }>,
    )
    // Exactly one change after typing, and it arrives after the pause, not during the keystrokes.
    expect(log).toHaveLength(1)
    expect(log[0].time - typingEnd).toBeGreaterThanOrEqual(400)
    const settled = await metrics(page, mode, TABLE_MIXED)
    // The status column grew with its content.
    expect(settled.widths[1]).toBeGreaterThan(initial.widths[1] + 2)
    await page.waitForTimeout(800)
    const stable = await metrics(page, mode, TABLE_MIXED)
    for (const [column, width] of stable.widths.entries())
      expect(Math.abs(width - settled.widths[column])).toBeLessThanOrEqual(0.5)
  })
}

test('tables far below the viewport are not measured until they come near', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const filler = Array.from(
    { length: 120 },
    (_, i) => `Filler paragraph number ${i + 1}.\n`,
  ).join('\n')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__ready === true)
  await constrainLayout(page)
  await page.evaluate(() => {
    const original = Element.prototype.getBoundingClientRect
    const reads: number[] = []
    ;(window as any).__farReads = reads
    ;(window as any).__restoreRect = () => {
      Element.prototype.getBoundingClientRect = original
    }
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const rect = original.call(this)
      // Reads of the hidden measurement host are the engine's own work on near tables.
      if (
        this.closest('.vditor-reset table') &&
        !this.closest('[data-vmde-measure]') &&
        rect.top > innerHeight * 2 + 100
      )
        reads.push(rect.top)
      return rect
    }
  })
  await page.evaluate(
    (source) => (window as any).vditor.setValue(source),
    `${FIXTURE}\n${filler}\n${FIXTURE.replace('# Table width baseline', '# Second copy')}`,
  )
  await waitForAuto(page, 'ir', TABLE_MIXED)
  await page.waitForTimeout(800)
  const state = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('.vditor-ir table'))
    return {
      count: tables.length,
      farClass: tables[3].getAttribute('class') ?? '',
      nearHasStyle: tables[0]
        .getAttribute('class')
        ?.includes('vmde-table-auto-'),
      reads: ((window as any).__farReads as number[]).length,
    }
  })
  expect(state.count).toBe(6)
  expect(state.nearHasStyle).toBe(true)
  expect(state.farClass).not.toMatch(AUTO_CLASS)
  expect(state.reads, 'off-screen table reads').toBe(0)

  await page.locator('.vditor-ir table').nth(3).scrollIntoViewIfNeeded()
  await page.waitForFunction(
    (pattern) =>
      new RegExp(pattern, 'u').test(
        document
          .querySelectorAll('.vditor-ir table')[3]
          ?.getAttribute('class') ?? '',
      ),
    AUTO_CLASS.source,
    AUTO_WAIT,
  )
  await page.evaluate(() => (window as any).__restoreRect())
})

test('inline code stays in its text line in an auto-width table', async ({
  page,
}) => {
  const source =
    '| Name | Notes |\n| --- | --- |\n| SVG post-processing`currentColor` | The importer reads every attached source file and reports each skipped record together with the reason it was skipped during the run, then waits for the next batch. |\n| plain | short |\n'
  await boot(page, 1280, source)
  await waitForAuto(page, 'ir', 0)
  const state = await page.evaluate(() => {
    const table = document.querySelectorAll('.vditor-ir table')[0]
    const cell = table.querySelectorAll('tr')[1].children[0] as HTMLElement
    const code = cell.querySelector('code')!
    const marker = cell.querySelector('.vditor-ir__marker') as HTMLElement
    // The collapsed backtick markers are zero-width boxes whose hidden glyph rects sit at odd
    // offsets, so the line check compares only the text before the code with the code itself.
    const range = document.createRange()
    range.selectNodeContents(cell.firstChild as Text)
    const textRects = Array.from(range.getClientRects())
    const lastText = textRects[textRects.length - 1]
    const codeRect = code.getBoundingClientRect()
    const sameLine =
      Math.abs(
        lastText.top +
          lastText.height / 2 -
          (codeRect.top + codeRect.height / 2),
      ) <
      lastText.height / 2
    return {
      codeTop:
        code.getBoundingClientRect().top - cell.getBoundingClientRect().top,
      lineHeight: parseFloat(getComputedStyle(cell).lineHeight),
      markerWidth: marker.getBoundingClientRect().width,
      sameLine,
    }
  })
  expect(state.codeTop).toBeLessThan(state.lineHeight * 2)
  expect(state.markerWidth).toBe(0)
  // The Name column takes its max-content, so the text and the code share one line.
  expect(state.sameLine).toBe(true)
})

test('re-initialising the helpers removes the old width rules', async ({
  page,
}) => {
  await boot(page)
  await waitForAuto(page, 'ir', TABLE_MIXED)
  const count = () =>
    page.evaluate(() => ({
      styles: Array.from(document.head.querySelectorAll('style')).filter(
        (style) => /vmde-table-auto-\d+/u.test(style.textContent ?? ''),
      ).length,
      tables: document.querySelectorAll(
        '.vditor-ir table[class*="vmde-table-auto-"]',
      ).length,
    }))
  await page.evaluate(() => (window as any).__fixResponsiveTables())
  await waitForAuto(page, 'ir', TABLE_MIXED)
  await page.waitForTimeout(500)
  const afterReinit = await count()
  expect(afterReinit.tables).toBeGreaterThan(0)
  expect(afterReinit.styles).toBe(afterReinit.tables)
})

// Two tables with different content-driven widths and the same column count, so a cached width
// set can be given to the wrong table only by a mismatch of identity, never by a column count.
const PAIR = `# Pair

| ID | Name | Description |
| --- | --- | --- |
| 1 | Ann | The importer reads every attached source file and reports each skipped record together with the reason it was skipped during the run. |
| 2 | Bob | A retry policy waits between attempts and gives up after the configured number of failures. |

| Description | ID | Name |
| --- | --- | --- |
| The scheduler groups queued jobs by owner and starts them in order of priority while keeping the total running count below the limit. | 3 | Cy |
| Documented in the operations handbook; the owner should confirm the wording before the end of the quarter review meeting. | 4 | Di |
`

/** Installs `window.__tableWidths(root)`: first-row widths of the top-level tables of `root`. */
const installWidthsReader = (page: Page) =>
  page.evaluate(() => {
    ;(window as any).__tableWidths = (root: Element): number[][] =>
      Array.from(root.querySelectorAll(':scope > table'), (table) =>
        Array.from(
          (table as HTMLTableElement).rows[0].cells,
          (cell) => cell.getBoundingClientRect().width,
        ),
      )
  })

const maxDifference = (left: number[], right: number[]): number =>
  Math.max(...left.map((width, index) => Math.abs(width - right[index])))

for (const edited of ['upper', 'lower'] as const) {
  test(`a table inserted above and an edit of the ${edited} table in one frame keep each table's own widths`, async ({
    page,
  }) => {
    await boot(page, 1280, PAIR)
    await installWidthsReader(page)
    await waitForAuto(page, 'ir', 0)
    await waitForAuto(page, 'ir', 1)
    await page.waitForTimeout(300)
    const result = await page.evaluate(async (which) => {
      const widthsOf = (window as any).__tableWidths as (
        root: Element,
      ) => number[][]
      const root = document.querySelector('.vditor-ir .vditor-reset')!
      const tables = Array.from(
        root.querySelectorAll<HTMLTableElement>(':scope > table'),
      )
      const before = widthsOf(root)
      // Vditor rebuilds the edited table without the width class.
      const fresh = (table: HTMLTableElement) => {
        const copy = table.cloneNode(true) as HTMLTableElement
        for (const name of Array.from(copy.classList))
          if (name.startsWith('vmde-table-')) copy.classList.remove(name)
        return copy
      }
      const inserted = fresh(tables[0])
      root.insertBefore(inserted, tables[0])
      const target = tables[which === 'upper' ? 0 : 1]
      const replacement = fresh(target)
      replacement.rows[1].cells[0].append('!')
      root.replaceChild(replacement, target)
      await Promise.resolve()
      const after = widthsOf(root)
      return { before, after, insertedClass: inserted.className }
    }, edited)
    // After: [inserted, upper, lower]. The edited table keeps the widths it had, the other table
    // is untouched, and the inserted table borrows nothing.
    expect(result.insertedClass).not.toMatch(AUTO_CLASS)
    expect(
      maxDifference(result.after[1], result.before[0]),
    ).toBeLessThanOrEqual(1.5)
    expect(
      maxDifference(result.after[2], result.before[1]),
    ).toBeLessThanOrEqual(1.5)
  })
}

test('a whole-content replace does not hand the cached widths to the other table', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await boot(page, 1280, PAIR)
  await installWidthsReader(page)
  await waitForAuto(page, 'ir', 0)
  await waitForAuto(page, 'ir', 1)
  await page.waitForTimeout(300)
  const result = await page.evaluate(async () => {
    const widthsOf = (window as any).__tableWidths as (
      root: Element,
    ) => number[][]
    const root = document.querySelector('.vditor-ir .vditor-reset')!
    const tables = Array.from(
      root.querySelectorAll<HTMLTableElement>(':scope > table'),
    )
    const before = widthsOf(root)
    const markup = (table: HTMLTableElement) => {
      const copy = table.cloneNode(true) as HTMLTableElement
      for (const name of Array.from(copy.classList))
        if (name.startsWith('vmde-table-')) copy.classList.remove(name)
      return copy.outerHTML
    }
    // An Undo-like restore: one assignment replaces everything, and the tables come back swapped.
    root.innerHTML = markup(tables[1]) + markup(tables[0])
    await Promise.resolve()
    return { before, immediately: widthsOf(root) }
  })
  // Not the other table's widths, even for a moment.
  expect(
    maxDifference(result.immediately[0], result.before[0]),
  ).toBeGreaterThan(20)
  expect(
    maxDifference(result.immediately[1], result.before[1]),
  ).toBeGreaterThan(20)
  // Then each table is measured for its own content.
  await waitForAuto(page, 'ir', 0)
  await waitForAuto(page, 'ir', 1)
  await page.waitForTimeout(800)
  const settled = await page.evaluate(
    () =>
      (window as any).__tableWidths(
        document.querySelector('.vditor-ir .vditor-reset')!,
      ) as number[][],
  )
  expect(maxDifference(settled[0], result.before[1])).toBeLessThanOrEqual(2)
  expect(maxDifference(settled[1], result.before[0])).toBeLessThanOrEqual(2)
  // The replaced tables leave no width rules behind.
  const rules = await page.evaluate(() => ({
    styles: Array.from(document.head.querySelectorAll('style')).filter(
      (style) => /vmde-table-auto-\d+/u.test(style.textContent ?? ''),
    ).length,
    tables: document.querySelectorAll(
      '.vditor-ir table[class*="vmde-table-auto-"]',
    ).length,
  }))
  expect(rules.styles).toBe(rules.tables)
})

test('a table about one viewport below the fold is measured before it scrolls in', async ({
  page,
}) => {
  const filler = Array.from(
    { length: 20 },
    (_, index) => `Filler paragraph number ${index + 1}.\n`,
  ).join('\n')
  await boot(page, 1280, `${filler}\n${FIXTURE}`, 800)
  const geometry = await page.evaluate(() => {
    const surface = document.querySelector('.vditor-ir .vditor-reset')!
    const table = surface.querySelector('table')!
    return {
      top: table.getBoundingClientRect().top,
      height: innerHeight,
      scrollTop: surface.scrollTop + document.scrollingElement!.scrollTop,
    }
  })
  // Below the fold, but within about one viewport of it.
  expect(geometry.top).toBeGreaterThan(geometry.height)
  expect(geometry.top).toBeLessThan(geometry.height * 1.9)
  expect(geometry.scrollTop).toBe(0)
  await waitForAuto(page, 'ir', TABLE_MIXED)
  const scrollTop = await page.evaluate(
    () =>
      document.querySelector('.vditor-ir .vditor-reset')!.scrollTop +
      document.scrollingElement!.scrollTop,
  )
  expect(scrollTop).toBe(0)
})

// Contract edge case: a column-count change is a recompute trigger. Vditor rebuilds the table
// without cached widths that fit, so the new table is measured for its four columns.
test('a table rebuilt with another column count is measured again', async ({
  page,
}) => {
  await boot(page, 1280, PAIR)
  await installWidthsReader(page)
  await waitForAuto(page, 'ir', 0)
  await page.evaluate(() => {
    const root = document.querySelector('.vditor-ir .vditor-reset')!
    const table = root.querySelector<HTMLTableElement>(':scope > table')!
    const copy = table.cloneNode(true) as HTMLTableElement
    for (const name of Array.from(copy.classList))
      if (name.startsWith('vmde-table-')) copy.classList.remove(name)
    for (const row of Array.from(copy.rows)) {
      const cell = document.createElement(row.cells[0].tagName.toLowerCase())
      cell.textContent = 'Extra'
      row.append(cell)
    }
    root.replaceChild(copy, table)
  })
  await waitForAuto(page, 'ir', 0)
  const state = await page.evaluate(() => {
    const table = document.querySelector<HTMLTableElement>(
      '.vditor-ir .vditor-reset > table',
    )!
    return {
      widths: Array.from(
        table.rows[0].cells,
        (cell) => cell.getBoundingClientRect().width,
      ),
      width: table.getBoundingClientRect().width,
    }
  })
  expect(state.widths).toHaveLength(4)
  expect(
    Math.abs(state.widths.reduce((sum, width) => sum + width, 0) - state.width),
  ).toBeLessThanOrEqual(1)
  // Content driven: the short ID and Extra columns are narrower than the prose column.
  expect(Math.max(...state.widths) / Math.min(...state.widths)).toBeGreaterThan(
    2,
  )
})
