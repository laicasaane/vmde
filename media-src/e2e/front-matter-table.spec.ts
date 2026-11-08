import { type Page, expect, test } from './coverage-fixture'

// Task 207 S8 — acceptance of the front-matter properties table in a real Vditor (production
// observer, copy installer and main.css). Probes P1–P4 of the handoff are kept as untagged
// regression tests: P1 collapsed geometry and ArrowUp entry, P2 click on table text, P3 button
// focus, P4 Undo depth. `--expand` lands one frame after a key (the marker-reveal controller is
// frame-coalesced), so every entry assertion polls.

const IR = '/front-matter-table.html'
const WYS = '/front-matter-table.html?mode=wysiwyg'

async function open(page: Page, url = IR) {
  await page.goto(url)
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.waitForSelector('[data-vmde-front-matter]', { timeout: 10000 })
}

const caretIntoHeading = (page: Page) =>
  page.evaluate(() => {
    const root = (window as any).__root() as HTMLElement
    const t = (root.querySelector('h1') as HTMLElement).lastChild as Text
    const range = document.createRange()
    range.setStart(t, 0)
    range.collapse(true)
    root.focus()
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })

/** Where the caret is and what the front-matter block shows right now. */
const blockState = (page: Page) =>
  page.evaluate(() => {
    const root = (window as any).__root() as HTMLElement
    const block = root.querySelector(
      'div[data-type="yaml-front-matter"]',
    ) as HTMLElement
    const pre = block.querySelector(':scope > pre') as HTMLElement
    const table = block.querySelector(
      ':scope > .vmde-front-matter',
    ) as HTMLElement | null
    const visible = (el: HTMLElement | null) =>
      !!el &&
      getComputedStyle(el).display !== 'none' &&
      el.getBoundingClientRect().height > 0
    const sel = window.getSelection()
    const a = sel?.rangeCount ? sel.anchorNode : null
    const host = a
      ? a.nodeType === 1
        ? (a as Element)
        : a.parentElement
      : null
    return {
      expand: block.classList.contains('vditor-ir__node--expand'),
      inCode: !!host?.closest('code[data-type="yaml-front-matter"]'),
      sourceVisible: visible(pre),
      tableVisible: visible(table),
      state: block.getAttribute('data-vmde-front-matter'),
    }
  })

test.describe('IR', () => {
  test.beforeEach(async ({ page }) => open(page))

  test('renders a two-column table with unquoted values', async ({ page }) => {
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.vmde-front-matter__row')].map((row) => [
        row.querySelector('.vmde-front-matter__key .vmde-front-matter__content')
          ?.textContent,
        row.querySelector(
          '.vmde-front-matter__value .vmde-front-matter__content',
        )?.textContent,
      ]),
    )
    expect(rows.map((r) => r[0])).toEqual([
      'title',
      'tags',
      'long',
      'description',
      'author',
    ])
    expect(rows[0][1]).toBe('Hello')
    expect(rows[1][1]).toBe('ab') // chips: a, b
    expect(await page.locator('.vmde-front-matter__chip').count()).toBe(2)
    expect(await page.locator('.vmde-front-matter__inner').count()).toBe(1)
    expect(await page.locator('.vmde-front-matter__inner button').count()).toBe(
      0,
    )
  })

  test('P1 collapsed block is exactly the table height (no leftover line)', async ({
    page,
  }) => {
    await caretIntoHeading(page)
    const g = await page.evaluate(() => {
      const block = (window as any)
        .__root()
        .querySelector('div[data-type="yaml-front-matter"]') as HTMLElement
      const table = block.querySelector(
        ':scope > .vmde-front-matter',
      ) as HTMLElement
      return {
        block: block.getBoundingClientRect().height,
        table: table.getBoundingClientRect().height,
      }
    })
    expect(g.table).toBeGreaterThan(40)
    expect(Math.abs(g.block - g.table)).toBeLessThanOrEqual(1)
  })

  test('P1 ArrowUp from the next block shows the YAML source, leaving shows the table', async ({
    page,
  }) => {
    await caretIntoHeading(page)
    await page.keyboard.press('ArrowUp')
    await expect
      .poll(() => blockState(page))
      .toMatchObject({
        expand: true,
        inCode: true,
        sourceVisible: true,
        tableVisible: false,
      })
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect
      .poll(() => blockState(page))
      .toMatchObject({
        expand: false,
        sourceVisible: false,
        tableVisible: true,
      })
  })

  test('P2 a click on table text puts the caret in the source', async ({
    page,
  }) => {
    await page
      .locator('.vmde-front-matter__content', { hasText: 'Hello' })
      .click()
    await expect
      .poll(() => blockState(page))
      .toMatchObject({
        expand: true,
        inCode: true,
        sourceVisible: true,
        tableVisible: false,
      })
  })

  test('P3 a copy button takes keyboard focus inside the non-editable table', async ({
    page,
  }) => {
    await page.keyboard.press('Shift')
    const result = await page.evaluate(() => {
      const button = document.querySelector(
        '.vmde-front-matter__copy',
      ) as HTMLButtonElement
      button.focus()
      return {
        active: document.activeElement === button,
        focusVisible: button.matches(':focus-visible'),
        outline: getComputedStyle(button).outlineStyle,
      }
    })
    expect(result).toEqual({
      active: true,
      focusVisible: true,
      outline: 'solid',
    })
  })

  test('P4 the injected table adds no Undo step', async ({ page }) => {
    const withTable = await page.evaluate(() => (window as any).__undoDepth())
    await page.goto('/front-matter-table.html?fm=0')
    await page.waitForFunction(() => (window as any).__ready === true)
    const without = await page.evaluate(() => (window as any).__undoDepth())
    expect(withTable).toBe(without)
  })

  test('copy buttons are always visible and right-aligned', async ({
    page,
  }) => {
    const cells = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '.vmde-front-matter__table > tbody > tr > :is(th, td)',
        ),
      ].map((cell) => {
        const button = cell.querySelector(
          ':scope > .vmde-front-matter__copy',
        ) as HTMLElement
        const c = cell.getBoundingClientRect()
        const b = button.getBoundingClientRect()
        const style = getComputedStyle(button)
        return {
          width: b.width,
          visible:
            style.visibility === 'visible' &&
            style.opacity !== '0' &&
            style.display !== 'none',
          gap: c.right - b.right,
          inside:
            b.left >= c.left && b.top >= c.top && b.bottom <= c.bottom + 1,
        }
      }),
    )
    expect(cells).toHaveLength(10)
    for (const cell of cells) {
      expect(cell.visible).toBe(true)
      expect(cell.width).toBeGreaterThanOrEqual(20)
      expect(cell.gap).toBeGreaterThanOrEqual(0)
      expect(cell.gap).toBeLessThanOrEqual(8)
      expect(cell.inside).toBe(true)
    }
  })

  for (const width of [320, 480, 800]) {
    test(`content never overlaps the copy button at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 700 })
      await caretIntoHeading(page)
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one in-page sweep over every cell's text line boxes against its button
      const overlaps = await page.evaluate(() => {
        const out: string[] = []
        for (const cell of document.querySelectorAll(
          '.vmde-front-matter__table > tbody > tr > :is(th, td)',
        )) {
          const button = cell.querySelector(
            ':scope > .vmde-front-matter__copy',
          ) as HTMLElement
          const b = button.getBoundingClientRect()
          // Every text line box of the cell's own content (not the nested inner table buttons).
          const walker = document.createTreeWalker(
            cell.querySelector(':scope > .vmde-front-matter__content') as Node,
            NodeFilter.SHOW_TEXT,
          )
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const range = document.createRange()
            range.selectNodeContents(n)
            for (const r of range.getClientRects()) {
              if (r.width === 0) continue
              const overlap =
                r.left < b.right &&
                r.right > b.left &&
                r.top < b.bottom &&
                r.bottom > b.top
              if (overlap)
                out.push(
                  `${(n.textContent ?? '').slice(0, 20)} @${Math.round(r.right)}>${Math.round(b.left)}`,
                )
            }
          }
        }
        const doc = document.documentElement
        return { out, pageOverflow: doc.scrollWidth > doc.clientWidth }
      })
      expect(overlaps.out).toEqual([])
      expect(overlaps.pageOverflow).toBe(false)
    })
  }

  test('the copy button is highlighted on hover and on keyboard focus', async ({
    page,
  }) => {
    const button = page.locator('.vmde-front-matter__copy').first()
    const rest = await button.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    )
    await button.hover()
    const hover = await button.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    )
    expect(hover).not.toBe(rest)
    await page.mouse.move(0, 0)
    await page.keyboard.press('Shift')
    await button.evaluate((el) => (el as HTMLElement).focus())
    const focus = await button.evaluate((el) => {
      const s = getComputedStyle(el)
      return { bg: s.backgroundColor, outline: s.outlineStyle }
    })
    expect(focus.bg).not.toBe(rest)
    expect(focus.outline).toBe('solid')
  })

  test('a click copies the cell text, swaps to the checkmark for 1.5 s and restores', async ({
    page,
  }) => {
    const button = page
      .locator('.vmde-front-matter__value .vmde-front-matter__copy')
      .first()
    const icons = () =>
      button.evaluate((el) => ({
        copied: el.hasAttribute('data-copied'),
        copy: getComputedStyle(
          el.querySelector('.vmde-front-matter__icon--copy')!,
        ).display,
        check: getComputedStyle(
          el.querySelector('.vmde-front-matter__icon--check')!,
        ).display,
      }))
    expect(await icons()).toEqual({
      copied: false,
      copy: 'flex',
      check: 'none',
    })
    await button.click()
    expect(await page.evaluate(() => (window as any).__posts)).toEqual([
      { command: 'copy-property', content: 'Hello' },
    ])
    expect(await icons()).toEqual({
      copied: true,
      copy: 'none',
      check: 'flex',
    })
    await page.waitForTimeout(1000)
    expect((await icons()).copied).toBe(true)
    await expect
      .poll(async () => (await icons()).copied, { timeout: 1500 })
      .toBe(false)
    expect(await icons()).toEqual({
      copied: false,
      copy: 'flex',
      check: 'none',
    })
  })

  test('a second click during the confirmation restarts the timer', async ({
    page,
  }) => {
    const button = page.locator('.vmde-front-matter__copy').first()
    await button.click()
    await page.waitForTimeout(1000)
    await button.click()
    await page.waitForTimeout(1000) // 2.0 s after the first click, 1.0 s after the second
    expect(await button.evaluate((el) => el.hasAttribute('data-copied'))).toBe(
      true,
    )
    await expect
      .poll(() => button.evaluate((el) => el.hasAttribute('data-copied')), {
        timeout: 1500,
      })
      .toBe(false)
  })

  test('D1 a copy click does not move the caret, expand the block or add an Undo step', async ({
    page,
  }) => {
    await caretIntoHeading(page)
    await page.waitForTimeout(150) // the heading's own marker reveal lands one frame later
    const snapshot = () =>
      page.evaluate(() => {
        const sel = window.getSelection()!
        return {
          anchor: sel.anchorNode?.textContent,
          offset: sel.anchorOffset,
          expanded: document.querySelectorAll('.vditor-ir__node--expand')
            .length,
          undo: (window as any).__undoDepth(),
        }
      })
    const before = await snapshot()
    await page
      .locator('.vmde-front-matter__value .vmde-front-matter__copy')
      .nth(1)
      .click()
    await page.waitForTimeout(150)
    expect(await snapshot()).toEqual(before)
    expect((await blockState(page)).expand).toBe(false)
    const posts = await page.evaluate(() => (window as any).__posts)
    expect(posts.at(-1)).toEqual({
      command: 'copy-property',
      content: '[a, b]',
    })
  })

  test('the saved markdown is identical with and without the table', async ({
    page,
  }) => {
    const withTable = await page.evaluate(() => (window as any).__getValue())
    await page.goto('/front-matter-table.html?observe=0')
    await page.waitForFunction(() => (window as any).__ready === true)
    expect(await page.locator('.vmde-front-matter').count()).toBe(0)
    expect(await page.evaluate(() => (window as any).__getValue())).toBe(
      withTable,
    )
  })
})

test('malformed YAML keeps the code block and shows the exact warning', async ({
  page,
}) => {
  await open(page, `${IR}?doc=bad`)
  expect(await page.locator('.vmde-front-matter__table').count()).toBe(0)
  expect(await page.locator('.vmde-front-matter__warning').textContent()).toBe(
    'Front matter could not be parsed: Map keys must be unique (line 3, column 1)',
  )
  const state = await blockState(page)
  expect(state).toMatchObject({ state: 'error', sourceVisible: true })
})

test.describe('WYSIWYG', () => {
  test.beforeEach(async ({ page }) => open(page, WYS))

  test('shows the table and hides the source until the caret enters, then swaps back', async ({
    page,
  }) => {
    const show = () =>
      page.evaluate(() => {
        const block = (window as any)
          .__root()
          .querySelector('div[data-type="yaml-front-matter"]') as HTMLElement
        const pre = block.querySelector(':scope > pre') as HTMLElement
        const table = block.querySelector(
          ':scope > .vmde-front-matter',
        ) as HTMLElement
        const shown = (el: HTMLElement) =>
          getComputedStyle(el).display !== 'none'
        return { source: shown(pre), table: shown(table) }
      })
    expect(await show()).toEqual({ source: false, table: true })
    await page
      .locator('.vmde-front-matter__content', { hasText: 'Hello' })
      .click()
    await expect.poll(show).toEqual({ source: true, table: false })
    await caretIntoHeading(page)
    // The source hides on the same tick as the caret leaves (not after Vditor's 200 ms delay).
    expect(await show()).toEqual({ source: false, table: true })
  })

  test('a copy click keeps the source hidden', async ({ page }) => {
    await page.locator('.vmde-front-matter__copy').first().click()
    const pre = await page.evaluate(
      () =>
        getComputedStyle(
          (window as any)
            .__root()
            .querySelector('div[data-type="yaml-front-matter"] > pre'),
        ).display,
    )
    expect(pre).toBe('none')
    expect((await page.evaluate(() => (window as any).__posts)).at(-1)).toEqual(
      {
        command: 'copy-property',
        content: 'title',
      },
    )
  })
})
