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

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`${mode} keeps Find and Replace modes, focus, and source separate`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    if (mode !== 'ir') {
      await page.evaluate((next) => (window as any).__switchMode(next), mode)
      await expect
        .poll(() => page.evaluate(() => (window as any).__mode()))
        .toBe(mode)
    }

    await page.evaluate(() => (window as any).__openFind())
    const widget = page.locator('.vmde-find-replace')
    const find = widget.locator('[data-find]')
    const replace = widget.locator('[data-replace]')
    const replaceRow = widget.locator('#vmde-find-replace-row')
    const toggle = widget.locator('[data-action="toggle-replace"]')
    const status = widget.locator('[data-status]')
    await expect(widget).toBeVisible()
    await expect(find).toBeFocused()
    await expect(replaceRow).toHaveCSS('display', 'none')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(widget.getByRole('textbox', { name: 'Replace' })).toHaveCount(
      0,
    )

    await widget.locator('[data-action="case"]').click()
    await widget.locator('[data-action="word"]').click()
    await find.fill(PAIR_TOKEN)
    expect(wholeWordMatches(FIXTURE, PAIR_TOKEN, true)).toHaveLength(2)
    await expect(status).toHaveText('1 of 2')
    await page.evaluate(() => (window as any).__findWidgetAction('next'))
    await expect(status).toHaveText('2 of 2')

    // Replace opened over focused Find expands the row and moves focus to Replace.
    await find.focus()
    await page.evaluate(() => (window as any).__openFindReplace())
    await expect(replaceRow).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(replace).toBeFocused()
    await expect(status).toHaveText('2 of 2')
    await replace.fill('replacement')

    // Find on an open Replace widget keeps the row and its value, but selects Find.
    await page.evaluate(() => (window as any).__openFind())
    await expect(replaceRow).toBeVisible()
    await expect(find).toBeFocused()
    expect(
      await find.evaluate(
        (input: HTMLInputElement) =>
          input.selectionStart === 0 &&
          input.selectionEnd === input.value.length,
      ),
    ).toBe(true)
    await expect(replace).toHaveValue('replacement')
    await expect(widget.locator('[data-action="case"]')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(widget.locator('[data-action="word"]')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(status).toHaveText('2 of 2')

    await toggle.click()
    await expect(toggle).toBeFocused()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(replaceRow).toHaveCSS('display', 'none')
    await expect(widget.getByRole('textbox', { name: 'Replace' })).toHaveCount(
      0,
    )
    const before = await exact(page)
    await page.evaluate(() => {
      ;(window as any).__findWidgetAction('replace-one')
      ;(window as any).__findWidgetAction('replace-all')
    })
    // Programmatic clicks model stale controls that remain in the DOM while hidden.
    await widget
      .locator('[data-action="replace"]')
      .evaluate((button) => (button as HTMLButtonElement).click())
    await widget
      .locator('[data-action="replace-all"]')
      .evaluate((button) => (button as HTMLButtonElement).click())
    expect((await exact(page)) === before).toBe(true)
    await expect(status).toHaveText('2 of 2')

    await toggle.click()
    await expect(toggle).toBeFocused()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(replace).toHaveValue('replacement')
    await page.evaluate(() => (window as any).__openFindReplace())
    await expect(find).toBeFocused()
    await page.evaluate(() => (window as any).__openFindReplace())
    await expect(replace).toBeFocused()

    await page.evaluate(() => (window as any).__findWidgetAction('close'))
    await expect(widget).toBeHidden()
    await page.evaluate(() => (window as any).__openFind())
    await expect(widget).toBeVisible()
    await expect(replaceRow).toHaveCSS('display', 'none')
    await expect(find).toBeFocused()
    await page.evaluate(() => (window as any).__findWidgetAction('close'))
    await page.evaluate(() => (window as any).__openFindReplace())
    await expect(replaceRow).toBeVisible()
    await expect(find).toBeFocused()
  })
}

test('match highlights follow their text when the toolbar hides and returns', async ({
  page,
}) => {
  const widget = await openWidget(page)
  const toolbar = page.locator('.vditor-toolbar')
  await expect(toolbar).toBeVisible()
  // The repeated prose token has exactly two literal matches. Find starts on the first, so its
  // current overlay must agree with the first matching text Range as toolbar geometry changes.
  expect(literalMatches(FIXTURE, PAIR_TOKEN, false)).toHaveLength(2)
  await widget.locator('[data-find]').fill(PAIR_TOKEN)
  await expect(widget.locator('[data-status]')).toHaveText('1 of 2')
  await expect(page.locator('.vmde-find-overlay--current')).toHaveCount(1)

  const highlightDrift = () =>
    page.locator('body').evaluate((_body, token) => {
      const editor = document.querySelector('.vditor-ir .vditor-reset')
      const overlay = document.querySelector('.vmde-find-overlay--current')
      if (!editor || !overlay) return Number.MAX_SAFE_INTEGER
      const matchRange = () => {
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = (node.nodeValue ?? '')
            .toLowerCase()
            .indexOf(token.toLowerCase())
          if (index < 0) continue
          const range = document.createRange()
          range.setStart(node, index)
          range.setEnd(node, index + token.length)
          return range
        }
        return null
      }
      const text = matchRange()?.getClientRects()[0]
      if (!text) return Number.MAX_SAFE_INTEGER
      const highlight = overlay.getBoundingClientRect()
      return Math.max(
        Math.abs(highlight.left - text.left),
        Math.abs(highlight.top - text.top),
        Math.abs(highlight.width - text.width),
        Math.abs(highlight.height - text.height),
      )
    }, PAIR_TOKEN)

  await expect.poll(highlightDrift).toBeLessThan(5)
  await toolbar.evaluate((element: HTMLElement) => {
    element.style.display = 'none'
  })
  await expect(toolbar).toBeHidden()
  await expect.soft
    .poll(highlightDrift, {
      message: 'hidden-toolbar highlight stays on its source Range',
      timeout: 3_000,
    })
    .toBeLessThan(5)

  await toolbar.evaluate((element: HTMLElement) => {
    element.style.removeProperty('display')
  })
  await expect(toolbar).toBeVisible()
  await expect.soft
    .poll(highlightDrift, {
      message: 'restored-toolbar highlight stays on its source Range',
      timeout: 3_000,
    })
    .toBeLessThan(5)
})

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
  await expect(widget.locator('[data-status]')).toHaveText('1 of 1')
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
  await expect(widget.locator('[data-status]')).toHaveText('1 of 2')
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
  await expect(widget.locator('[data-status]')).toHaveText(`1 of ${total}`)
  // Every occurrence is revealed as the current match and highlighted exactly there; an
  // unmappable current match paints no current highlight and sets the status title.
  const unmapped: number[] = []
  const unmappedReasons: {
    index: number
    painted: boolean
    titleSet: boolean
  }[] = []
  for (let index = 1; index <= total; index++) {
    await expect(widget.locator('[data-status]')).toHaveText(
      `${index} of ${total}`,
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
    if (!mapped || title !== '') {
      unmapped.push(index)
      unmappedReasons.push({ index, painted: mapped, titleSet: title !== '' })
    }
    await widget.locator('[data-action="next"]').click()
  }
  if (unmappedReasons.length)
    console.log(
      '[Task 579 mapping diagnostic]',
      JSON.stringify(unmappedReasons),
    )
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
    `1 of ${matches.length}`,
  )
  const before = await rendered(page)
  await widget.locator('[data-replace]').fill('ZZZZ')
  await widget.locator('[data-action="replace-all"]').click()
  const expected = applyReplacements(FIXTURE, matches, 'ZZZZ')
  await expect.poll(async () => (await exact(page)) === expected).toBe(true)
  await expect(widget.locator('[data-status]')).toHaveText('No results')

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
  await expect(widget.locator('[data-status]')).toHaveText(
    `1 of ${substringCi}`,
  )
  await widget.locator('[data-action="word"]').click()
  await expect(widget.locator('[data-status]')).toHaveText(`1 of ${wholeCi}`)
  await widget.locator('[data-action="case"]').click()
  await expect(widget.locator('[data-status]')).toHaveText(`1 of ${wholeCs}`)
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
    await expect(widget.locator('[data-status]')).toHaveText('1 of 1')
    await expect(page.locator('.vmde-find-overlay--current')).toHaveCount(1)
    await widget.locator('[data-replace]').fill('replaceduniqueword')
    await widget.locator('[data-action="replace"]').click()
    const expected = applyReplacements(FIXTURE, matches, 'replaceduniqueword')
    await expect.poll(async () => (await exact(page)) === expected).toBe(true)
  })
}
