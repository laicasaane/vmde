/**
 * Task 196 — the pre-existing Find & Replace contract cases on the large synthetic fixture (Test
 * fixture scope, task record 2026-09-26: every Find & Replace test in this rework uses only that
 * fixture). Query tokens come from `find-replace-fixture-helpers.ts`; every expected count and
 * every expected document is derived from the fixture's exact bytes with the widget's own search
 * semantics (literal, case-insensitive unless toggled, substring unless Whole Word is on).
 *
 * Fixture text must stay out of failure output, so document comparisons assert booleans.
 * Performance and work-counter phases live in `find-replace-large.spec.ts`.
 */
import { createHash } from 'node:crypto'
import { expect, test } from './coverage-fixture'
import {
  FIXTURE,
  FIXTURE_SHA256,
  BOLD_TOKEN,
  PAIR_TOKEN,
  CROSS_REGION_TOKEN,
  QUERY_TOKEN,
  UNIQUE_PROSE_TOKEN,
  applyReplacements,
  literalMatches,
  regionCounts,
  substringCount,
  wholeWordCount,
  wholeWordMatches,
} from '../../test/vscode-e2e/find-replace-fixture-helpers'

type Page = import('@playwright/test').Page

test.beforeEach(async ({ page }) => {
  test.setTimeout(120_000)
  expect(createHash('sha256').update(FIXTURE).digest('hex')).toBe(
    FIXTURE_SHA256,
  )
  await page.goto('/structural-selection.html')
  await page.waitForFunction(
    () => (window as unknown as { __ready?: boolean }).__ready,
  )
  await page.evaluate((source) => (window as any).__setValue(source), FIXTURE)
})

const rendered = (page: Page) =>
  page.evaluate(() => (window as any).__getValue() as string)
const exact = (page: Page) =>
  page.evaluate(() => (window as any).__exact() as string)

async function openWidget(page: Page) {
  await page.evaluate(() => (window as any).__openFindReplace())
  const widget = page.locator('.vmde-find-replace')
  await expect(widget).toBeVisible()
  return widget
}

test('source-accurate widget replaces an inline match without corrupting markers', async ({
  page,
}) => {
  const widget = await openWidget(page)
  // BOLD_TOKEN is unique only as a case-sensitive whole word (inside a bold span).
  const matches = wholeWordMatches(FIXTURE, BOLD_TOKEN, true)
  expect(matches).toHaveLength(1)
  await widget.locator('[data-action="case"]').click()
  await widget.locator('[data-action="word"]').click()
  await widget.locator('[data-find]').fill(BOLD_TOKEN)
  await expect(widget.locator('[data-status]')).toHaveText('1/1')
  await expect(page.locator('.vmde-find-overlay--current')).toHaveCount(1)
  await widget.locator('[data-replace]').fill('Ldbwreplaced')
  await widget.locator('[data-action="replace"]').click()
  const expected = applyReplacements(FIXTURE, matches, 'Ldbwreplaced')
  await expect.poll(async () => (await exact(page)) === expected).toBe(true)
  expect((await rendered(page)).includes('VMDE_FIND_CARET')).toBe(false)
  expect(await page.locator('.vditor-ir [data-action]').count()).toBe(0)
})

test('decorates each repeated visible occurrence instead of its containing block', async ({
  page,
}) => {
  const widget = await openWidget(page)
  expect(literalMatches(FIXTURE, PAIR_TOKEN, true)).toHaveLength(2)
  await widget.locator('[data-action="case"]').click()
  await widget.locator('[data-find]').fill(PAIR_TOKEN)
  await expect(widget.locator('[data-status]')).toHaveText('1/2')
  await expect(page.locator('.vmde-find-overlay')).toHaveCount(2)

  const geometry = await page.locator('body').evaluate(() => {
    const overlays = Array.from(
      document.querySelectorAll<HTMLElement>('.vmde-find-overlay'),
    ).map((overlay) => {
      const rect = overlay.getBoundingClientRect()
      return { left: rect.left, top: rect.top, width: rect.width }
    })
    // The overlay is pointer-inert, so the element under its centre is the matched text's block.
    const first = document.querySelector<HTMLElement>('.vmde-find-overlay')!
    const rect = first.getBoundingClientRect()
    const block = document
      .elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      ?.closest<HTMLElement>('[data-block]')
    return {
      overlays,
      blockWidth: block?.getBoundingClientRect().width ?? null,
    }
  })
  expect(geometry.blockWidth).not.toBeNull()
  expect(geometry.overlays).toHaveLength(2)
  expect(
    geometry.overlays.every(
      (overlay) => overlay.width < (geometry.blockWidth ?? 0),
    ),
  ).toBe(true)
  expect(geometry.overlays[0]?.left).not.toBe(geometry.overlays[1]?.left)
})

test('maps each prose, code, and table occurrence in a mixed document', async ({
  page,
}) => {
  const widget = await openWidget(page)
  const regions = regionCounts(FIXTURE, CROSS_REGION_TOKEN, true)
  expect(regions.prose).toBeGreaterThan(0)
  expect(regions.fence).toBeGreaterThan(0)
  expect(regions.table).toBeGreaterThan(0)
  const total = literalMatches(FIXTURE, CROSS_REGION_TOKEN, true).length
  expect(total).toBe(regions.prose + regions.fence + regions.table)
  await widget.locator('[data-action="case"]').click()
  await widget.locator('[data-find]').fill(CROSS_REGION_TOKEN)
  await expect(widget.locator('[data-status]')).toHaveText(`1/${total}`)
  // Every occurrence is revealed as the current match and highlighted exactly there; an
  // unmappable current match paints no current highlight and sets the status title.
  const unmapped: number[] = []
  for (let index = 1; index <= total; index++) {
    await expect(widget.locator('[data-status]')).toHaveText(
      `${index}/${total}`,
    )
    const mapped = await expect
      .poll(() => page.locator('.vmde-find-overlay--current').count(), {
        timeout: 2_000,
      })
      .toBeGreaterThan(0)
      .then(
        () => true,
        () => false,
      )
    const title = await widget.locator('[data-status]').getAttribute('title')
    if (!mapped || title !== '') unmapped.push(index)
    await widget.locator('[data-action="next"]').click()
  }
  expect(unmapped).toEqual([])
})

test('Replace All covers prose, fenced source, and table in one undo step', async ({
  page,
}) => {
  const widget = await openWidget(page)
  const matches = literalMatches(FIXTURE, CROSS_REGION_TOKEN, true)
  await widget.locator('[data-action="case"]').click()
  await widget.locator('[data-find]').fill(CROSS_REGION_TOKEN)
  await expect(widget.locator('[data-status]')).toHaveText(
    `1/${matches.length}`,
  )
  const before = await rendered(page)
  await widget.locator('[data-replace]').fill('ZZZZ')
  await widget.locator('[data-action="replace-all"]').click()
  const expected = applyReplacements(FIXTURE, matches, 'ZZZZ')
  await expect.poll(async () => (await exact(page)) === expected).toBe(true)
  await expect(widget.locator('[data-status]')).toHaveText('0/0')

  await page.evaluate(() => (window as any).__undoFindReplace())
  await expect.poll(async () => (await rendered(page)) === before).toBe(true)
})

test('case/whole-word toggles update counts and Escape closes', async ({
  page,
}) => {
  const widget = await openWidget(page)
  const substringCi = substringCount(FIXTURE, QUERY_TOKEN, false)
  const wholeCi = wholeWordCount(FIXTURE, QUERY_TOKEN, false)
  const wholeCs = wholeWordCount(FIXTURE, QUERY_TOKEN, true)
  expect(substringCi).toBeGreaterThan(wholeCi)
  expect(wholeCi).toBeGreaterThan(wholeCs)
  await widget.locator('[data-find]').fill(QUERY_TOKEN)
  await expect(widget.locator('[data-status]')).toHaveText(`1/${substringCi}`)
  await widget.locator('[data-action="word"]').click()
  await expect(widget.locator('[data-status]')).toHaveText(`1/${wholeCi}`)
  await widget.locator('[data-action="case"]').click()
  await expect(widget.locator('[data-status]')).toHaveText(`1/${wholeCs}`)
  await widget.locator('[data-find]').press('Escape')
  await expect(widget).toBeHidden()
})

for (const mode of ['wysiwyg', 'sv'] as const) {
  test(`${mode} uses the same source replacement transaction`, async ({
    page,
  }) => {
    await page.evaluate((next) => (window as any).__switchMode(next), mode)
    await expect
      .poll(() => page.evaluate(() => (window as any).__mode()))
      .toBe(mode)
    const widget = await openWidget(page)
    // Unique as a case-sensitive substring (it also occurs once more in another case).
    const matches = literalMatches(FIXTURE, UNIQUE_PROSE_TOKEN, true)
    expect(matches).toHaveLength(1)
    await widget.locator('[data-action="case"]').click()
    await widget.locator('[data-find]').fill(UNIQUE_PROSE_TOKEN)
    await expect(widget.locator('[data-status]')).toHaveText('1/1')
    await expect(page.locator('.vmde-find-overlay--current')).toHaveCount(1)
    await widget.locator('[data-replace]').fill('replaceduniqueword')
    await widget.locator('[data-action="replace"]').click()
    const expected = applyReplacements(FIXTURE, matches, 'replaceduniqueword')
    await expect.poll(async () => (await exact(page)) === expected).toBe(true)
  })
}
