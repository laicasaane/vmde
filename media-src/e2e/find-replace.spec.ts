/**
 * Task 196 Checkpoint 1 — the 7 pre-existing Find & Replace contract cases, migrated from small
 * inline documents onto the large synthetic fixture (Test fixture scope, task record 2026-09-26:
 * every Find & Replace test in this rework uses only that fixture). Query tokens are derived from
 * the fixture's exact bytes by `find-replace-fixture-helpers.ts`; expected counts are recomputed
 * from the loaded text at test time, never hard-coded from a rendered DOM.
 *
 * These are individually the CHEAPEST fixture interactions available (1-2 matches each, one query
 * fill per test) but still pay the current implementation's whole-document clone+serialize cost on
 * every fill/toggle/replace — they are expected to be slow, and some assertions red, until
 * Checkpoints 2-5. `test.setTimeout` and per-action `timeout` below are the "same per-phase
 * deadlines" gate the task record calls for, so a stuck action fails this ONE test with a clear
 * TimeoutError instead of hanging the whole run. New performance/work-counter phases (typing,
 * scrolling, toggling, editor-click-while-open) live in `find-replace-large.spec.ts`, split out so a
 * timeout there cannot hide these contract results (and vice versa).
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
  regionCounts,
  substringCount,
  wholeWordCount,
} from '../../test/vscode-e2e/find-replace-fixture-helpers'

// Coordinator guidance (2026-09-26): bound each migrated case at ~120s total so a red run of all 7
// finishes deterministically instead of stacking up multiple long per-action waits.
const ACTION_TIMEOUT = 100_000

test.beforeEach(async ({ page }) => {
  test.setTimeout(120_000)
  expect(createHash('sha256').update(FIXTURE).digest('hex')).toBe(
    FIXTURE_SHA256,
  )
  await page.goto('/structural-selection.html')
  await page.waitForFunction(
    () => (window as unknown as { __ready?: boolean }).__ready,
  )
  await page.waitForTimeout(250)
  await page.evaluate((source) => (window as any).__setValue(source), FIXTURE)
})

const value = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__getValue() as string)

test('source-accurate widget replaces an inline match without corrupting markers', async ({
  page,
}) => {
  await page.evaluate(() => (window as any).__openFindReplace())
  const widget = page.locator('.vmde-find-replace')
  await expect(widget).toBeVisible()
  // BOLD_TOKEN is case-sensitively unique; the default search is case-insensitive, so enable case
  // matching first to isolate the single bold occurrence (a fixture-derived analogue of the
  // original test's hand-picked "bold scope" phrase, which was unique by construction).
  await widget
    .locator('[data-action="case"]')
    .click({ timeout: ACTION_TIMEOUT })
  await widget
    .locator('[data-find]')
    .fill(BOLD_TOKEN, { timeout: ACTION_TIMEOUT })
  await expect(widget.locator('[data-status]')).toHaveText('1/1', {
    timeout: ACTION_TIMEOUT,
  })
  expect(await page.locator('.vmde-find-overlay').count()).toBe(1)
  await widget.locator('[data-replace]').fill('Ldbwreplaced')
  await widget
    .locator('[data-action="replace"]')
    .click({ timeout: ACTION_TIMEOUT })
  await expect
    .poll(() => value(page), { timeout: ACTION_TIMEOUT })
    .toContain('Ldbwreplaced')
  expect(await value(page)).not.toContain('VMDE_FIND_CARET')
  expect(await page.locator('.vditor-ir [data-action]').count()).toBe(0)
})

test('decorates each repeated visible occurrence instead of its containing block', async ({
  page,
}) => {
  await page.evaluate(() => (window as any).__openFindReplace())
  const widget = page.locator('.vmde-find-replace')
  // PAIR_TOKEN's global count is exactly 2 case-sensitively (both on one prose line); enable case
  // matching so the widget's count matches that, not the case-insensitive superset.
  await widget
    .locator('[data-action="case"]')
    .click({ timeout: ACTION_TIMEOUT })
  await widget
    .locator('[data-find]')
    .fill(PAIR_TOKEN, { timeout: ACTION_TIMEOUT })
  await expect(widget.locator('[data-status]')).toHaveText('1/2', {
    timeout: ACTION_TIMEOUT,
  })

  const geometry = await page.locator('body').evaluate(() => {
    const overlays = Array.from(
      document.querySelectorAll<HTMLElement>('.vmde-find-overlay'),
    ).map((overlay) => {
      const rect = overlay.getBoundingClientRect()
      return { left: rect.left, width: rect.width }
    })
    // The fixture is large, so PAIR_TOKEN's containing block is not necessarily block 0 — locate
    // the block that actually sits under the first overlay instead of assuming an index.
    const first = document.querySelector<HTMLElement>('.vmde-find-overlay')!
    const rect = first.getBoundingClientRect()
    const block = document
      .elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      ?.closest<HTMLElement>('[data-block]')
    if (!block)
      throw new Error('overlay has no enclosing [data-block] ancestor')
    return { overlays, blockWidth: block.getBoundingClientRect().width }
  })
  expect(geometry.overlays).toHaveLength(2)
  expect(
    geometry.overlays.every((overlay) => overlay.width < geometry.blockWidth),
  ).toBe(true)
  expect(geometry.overlays[0]?.left).not.toBe(geometry.overlays[1]?.left)
})

test('maps each prose, code, and table occurrence in a mixed document', async ({
  page,
}) => {
  await page.evaluate(() => (window as any).__openFindReplace())
  const widget = page.locator('.vmde-find-replace')
  await widget
    .locator('[data-action="case"]')
    .click({ timeout: ACTION_TIMEOUT })
  const expected = regionCounts(FIXTURE, CROSS_REGION_TOKEN, true)
  const total = expected.prose + expected.fence + expected.table
  expect(expected.prose).toBeGreaterThan(0)
  expect(expected.fence).toBeGreaterThan(0)
  expect(expected.table).toBeGreaterThan(0)
  await widget
    .locator('[data-find]')
    .fill(CROSS_REGION_TOKEN, { timeout: ACTION_TIMEOUT })
  await expect(widget.locator('[data-status]')).toHaveText(`1/${total}`, {
    timeout: ACTION_TIMEOUT,
  })
  await expect(page.locator('.vmde-find-overlay')).toHaveCount(total, {
    timeout: ACTION_TIMEOUT,
  })
})

test('Replace All covers prose, fenced source, and table in one undo step', async ({
  page,
}) => {
  await page.evaluate(() => (window as any).__openFindReplace())
  const widget = page.locator('.vmde-find-replace')
  await widget
    .locator('[data-action="case"]')
    .click({ timeout: ACTION_TIMEOUT })
  const expected = regionCounts(FIXTURE, CROSS_REGION_TOKEN, true)
  const total = expected.prose + expected.fence + expected.table
  await widget
    .locator('[data-find]')
    .fill(CROSS_REGION_TOKEN, { timeout: ACTION_TIMEOUT })
  await expect(widget.locator('[data-status]')).toHaveText(`1/${total}`, {
    timeout: ACTION_TIMEOUT,
  })
  await widget.locator('[data-replace]').fill('ZZZZ')
  await widget
    .locator('[data-action="replace-all"]')
    .click({ timeout: ACTION_TIMEOUT })
  await expect
    .poll(() => value(page), { timeout: ACTION_TIMEOUT })
    .not.toMatch(new RegExp(`\\b${CROSS_REGION_TOKEN}\\b`))
  expect(await value(page)).toContain('ZZZZ')

  await page.evaluate(() => (window as any).__undoFindReplace())
  await expect
    .poll(() => value(page), { timeout: ACTION_TIMEOUT })
    .toMatch(new RegExp(`\\b${CROSS_REGION_TOKEN}\\b`))
})

test('case/whole-word toggles update counts and Escape closes', async ({
  page,
}) => {
  await page.evaluate(() => (window as any).__openFindReplace())
  const widget = page.locator('.vmde-find-replace')
  // QUERY_TOKEN has a large case/word-driven spread on this fixture: substring+case-insensitive >
  // whole-word+case-insensitive > whole-word+case-sensitive — the same escalating-restriction shape
  // as the original hand-picked "Alpha alpha alphabet" case, computed here instead of hard-coded.
  const substringCi = substringCount(FIXTURE, QUERY_TOKEN, false)
  const wholeCi = wholeWordCount(FIXTURE, QUERY_TOKEN, false)
  const wholeCs = wholeWordCount(FIXTURE, QUERY_TOKEN, true)
  expect(substringCi).toBeGreaterThan(wholeCi)
  expect(wholeCi).toBeGreaterThan(wholeCs)
  await widget
    .locator('[data-find]')
    .fill(QUERY_TOKEN, { timeout: ACTION_TIMEOUT })
  await expect(widget.locator('[data-status]')).toHaveText(`1/${substringCi}`, {
    timeout: ACTION_TIMEOUT,
  })
  await widget
    .locator('[data-action="word"]')
    .click({ timeout: ACTION_TIMEOUT })
  await expect(widget.locator('[data-status]')).toHaveText(`1/${wholeCi}`, {
    timeout: ACTION_TIMEOUT,
  })
  await widget
    .locator('[data-action="case"]')
    .click({ timeout: ACTION_TIMEOUT })
  await expect(widget.locator('[data-status]')).toHaveText(`1/${wholeCs}`, {
    timeout: ACTION_TIMEOUT,
  })
  await widget.locator('[data-find]').press('Escape')
  await expect(widget).toBeHidden()
})

for (const mode of ['wysiwyg', 'sv'] as const) {
  test(`${mode} uses the same source replacement transaction`, async ({
    page,
  }) => {
    await page.evaluate((next) => (window as any).__switchMode(next), mode)
    await expect
      .poll(() => page.evaluate(() => (window as any).__mode()), {
        timeout: ACTION_TIMEOUT,
      })
      .toBe(mode)
    await page.evaluate(() => (window as any).__openFindReplace())
    const widget = page.locator('.vmde-find-replace')
    await widget
      .locator('[data-find]')
      .fill(UNIQUE_PROSE_TOKEN, { timeout: ACTION_TIMEOUT })
    await expect(widget.locator('[data-status]')).toHaveText('1/1', {
      timeout: ACTION_TIMEOUT,
    })
    await widget.locator('[data-replace]').fill('replaceduniqueword')
    await widget
      .locator('[data-action="replace"]')
      .click({ timeout: ACTION_TIMEOUT })
    await expect
      .poll(() => value(page), { timeout: ACTION_TIMEOUT })
      .toContain('replaceduniqueword')
  })
}
