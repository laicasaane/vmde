import { expect, test } from './coverage-fixture'

const OWNER_ROW_ONE = [
  'undo',
  'redo',
  '|',
  'headings',
  '|',
  'bold',
  'italic',
  'underline',
  'strike',
  'inline-code',
  '|',
  'subscript',
  'superscript',
  '|',
  'link',
  '|',
  'list',
  'ordered-list',
  'check',
  '|',
  'outdent',
  'indent',
  'collapse-toolbar',
]
const OWNER_ROW_TWO = [
  'quote',
  'callout',
  'details',
  'code',
  'math',
  'table',
  'line',
  '|',
  'upload',
  'emoji',
  '|',
  'insert-before',
  'insert-after',
  '|',
  'outline',
  'preview',
  '|',
  'navigate-back',
  'wiki-pages',
  '|',
  'edit-in-vscode',
  'edit-mode',
  'more',
]

test('matches the owner row order and keeps Math in row two through wide, narrow, and restored layouts', async ({
  page,
}) => {
  const readRows = () =>
    page.locator('.vditor-toolbar').evaluate((toolbar) =>
      Array.from(
        toolbar.querySelectorAll<HTMLElement>(':scope > .vmde-toolbar-row'),
      ).map((row) =>
        Array.from(row.children)
          .filter((child) => getComputedStyle(child).display !== 'none')
          .map((child) =>
            child.classList.contains('vditor-toolbar__divider')
              ? '|'
              : (child
                  .querySelector(':scope > [data-type]')
                  ?.getAttribute('data-type') ?? ''),
          ),
      ),
    )
  const readControls = () =>
    page.locator('.vditor-toolbar').evaluate((toolbar) =>
      Array.from(
        toolbar.querySelectorAll<HTMLElement>(
          ':scope > .vmde-toolbar-row > .vditor-toolbar__item > [data-type], .vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type]',
        ),
      )
        .map((button) => button.getAttribute('data-type') ?? '')
        .sort(),
    )

  for (const wikiEnabled of [true, false]) {
    await page.goto(
      `/toolbar-overflow.html?wiki=${wikiEnabled ? 'enabled' : 'disabled'}`,
    )
    await page.waitForFunction(() => (window as any).__ready === true)
    await page.setViewportSize({ width: 1400, height: 700 })

    const rowTwo = wikiEnabled
      ? OWNER_ROW_TWO
      : [
          ...OWNER_ROW_TWO.slice(0, OWNER_ROW_TWO.indexOf('navigate-back') - 1),
          ...OWNER_ROW_TWO.slice(OWNER_ROW_TWO.indexOf('edit-in-vscode') - 1),
        ]
    const expectedRows = [OWNER_ROW_ONE, rowTwo]
    const expectedControls = expectedRows
      .flat()
      .filter((name) => name !== '|')
      .sort()

    await expect.poll(readRows).toEqual(expectedRows)
    expect(await readControls()).toEqual(expectedControls)

    const rowMath = page.locator(
      '.vmde-toolbar-row[data-vmde-toolbar-row="2"] > .vditor-toolbar__item > [data-type="math"]',
    )
    await expect(rowMath).toBeVisible()
    const rowIcon = rowMath.locator(':scope > svg')
    await expect(rowIcon).toHaveAttribute('width', '16')
    await expect(rowIcon).toHaveAttribute('height', '16')
    await expect(rowIcon.locator('path')).toHaveAttribute(
      'fill',
      'currentColor',
    )

    await page.setViewportSize({ width: 80, height: 700 })
    const mathInMore = page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type="math"]',
    )
    await expect(mathInMore).toHaveCount(1)
    await expect(page.locator('.vmde-toolbar-more')).toBeVisible()
    const narrowRows = await readRows()
    expect(narrowRows).toHaveLength(2)
    for (const row of narrowRows) {
      expect(row[0]).not.toBe('|')
      expect(row[row.length - 1]).not.toBe('|')
      for (let index = 1; index < row.length; index++)
        expect(row[index - 1] === '|' && row[index] === '|').toBe(false)
    }
    expect(await readControls()).toEqual(expectedControls)

    const moreButton = page.locator('.vmde-toolbar-more > [data-type="more"]')
    await moreButton.focus()
    await page.keyboard.press('Enter')
    const panel = page.locator('.vmde-toolbar-more > .vditor-hint')
    await expect(panel).toBeVisible()
    await expect(mathInMore.locator(':scope > svg path')).toHaveAttribute(
      'fill',
      'currentColor',
    )
    await page.keyboard.press('Escape')
    await expect(panel).not.toBeVisible()
    // Escape exits the toolbar and restores the editor focus, as defined by escape-toolbar.ts.
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(document.activeElement?.closest('.vditor-ir')),
        ),
      )
      .toBe(true)

    await page.setViewportSize({ width: 1400, height: 700 })
    await expect(
      page.locator(
        '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
      ),
    ).toHaveCount(0)
    await expect.poll(readRows).toEqual(expectedRows)
  }
})

test('moves overflowed items into more and restores their authored order', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)

  await page.setViewportSize({ width: 360, height: 700 })
  await expect(page.locator('.vmde-toolbar-more')).toBeVisible()
  // Row one and row two have independent budgets: a narrow width may move every inline-formatting
  // group while the structural row still has a different surviving set.
  await expect(
    page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
    ),
  ).not.toHaveCount(0, { timeout: 5_000 })
  const narrow = await page.evaluate(() => {
    const toolbar = document.querySelector('.vditor-toolbar') as HTMLElement
    const more = toolbar.querySelector(
      '.vmde-toolbar-more > .vditor-hint',
    ) as HTMLElement
    return {
      hasOverflow: Boolean(more.querySelector('[data-vmde-overflow="true"]')),
      rowCount: toolbar.querySelectorAll(':scope > .vmde-toolbar-row').length,
      overflowTabbable: [...more.querySelectorAll('button')].some(
        (button) => button.tabIndex === 0,
      ),
      moreExpanded: toolbar
        .querySelector('.vmde-toolbar-more > button')
        ?.getAttribute('aria-expanded'),
    }
  })
  expect(narrow.hasOverflow).toBe(true)
  expect(narrow.rowCount).toBe(2)
  expect(narrow.overflowTabbable).toBe(true)
  expect(narrow.moreExpanded).toBe('false')

  await page.setViewportSize({ width: 1400, height: 700 })
  await expect(
    page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
    ),
  ).toHaveCount(0, { timeout: 5_000 })
  const order = await page
    .locator('.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item')
    .evaluateAll((items) =>
      items
        .map((item) =>
          item.querySelector(':scope > [data-type]')?.getAttribute('data-type'),
        )
        .filter(Boolean),
    )
  expect(order.indexOf('headings')).toBeLessThan(order.indexOf('bold'))
  expect(order.indexOf('bold')).toBeLessThan(order.indexOf('emoji'))
})

test('keeps Emoji, Undo, and Redo as direct primary controls at supported widths', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)

  for (const width of [1400, 800, 360, 180]) {
    await page.setViewportSize({ width, height: 700 })
    const primary = () =>
      page.locator('.vditor-toolbar').evaluate((toolbar) => {
        const bounds = (button: HTMLElement) => {
          const rect = button.getBoundingClientRect()
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          }
        }
        const result = ['emoji', 'undo', 'redo'].map((name) => {
          const button = toolbar.querySelector<HTMLElement>(
            `:scope > .vmde-toolbar-row > .vditor-toolbar__item > [data-type="${name}"]`,
          )
          return {
            name,
            direct: Boolean(button),
            inMore: Boolean(
              toolbar.querySelector(
                `.vmde-toolbar-more .vditor-toolbar__item[data-vmde-overflow="true"] [data-type="${name}"]`,
              ),
            ),
            bounds: button ? bounds(button) : null,
          }
        })
        const toolbarRect = toolbar.getBoundingClientRect()
        return { result, toolbarRect }
      })
    await expect.poll(primary).toMatchObject({
      result: [
        { name: 'emoji', direct: true, inMore: false },
        { name: 'undo', direct: true, inMore: false },
        { name: 'redo', direct: true, inMore: false },
      ],
    })
    const { result, toolbarRect } = await primary()
    for (const control of result) {
      expect(control.bounds).not.toBeNull()
      expect(control.bounds!.left).toBeGreaterThanOrEqual(toolbarRect.left)
      expect(control.bounds!.right).toBeLessThanOrEqual(toolbarRect.right)
    }
  }
})

test('keeps two unclipped row bands through narrow widths, zoom, and row-boundary keyboard navigation', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)

  const geometry = () =>
    page.evaluate(() => {
      const toolbar = document.querySelector('.vditor-toolbar') as HTMLElement
      const rect = (element: Element) => {
        const box = (element as HTMLElement).getBoundingClientRect()
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
        }
      }
      const rows = Array.from(
        toolbar.querySelectorAll<HTMLElement>(':scope > .vmde-toolbar-row'),
      ).map((row) => ({
        rect: rect(row),
        controls: Array.from(
          row.querySelectorAll<HTMLElement>(
            ':scope > .vditor-toolbar__item > [data-type]',
          ),
        )
          .filter((button) => getComputedStyle(button).display !== 'none')
          .map((button) => ({ name: button.dataset.type, rect: rect(button) })),
      }))
      const more = toolbar.querySelector<HTMLElement>(
        '.vmde-toolbar-more > [data-type="more"]',
      )
      return {
        toolbar: rect(toolbar),
        pageClientWidth: document.documentElement.clientWidth,
        pageScrollWidth: document.documentElement.scrollWidth,
        rows,
        more: more ? rect(more) : null,
      }
    })

  for (const width of [1400, 800, 360, 180]) {
    await page.setViewportSize({ width, height: 700 })
    await expect
      .poll(async () => {
        const current = await geometry()
        return (
          current.more !== null &&
          current.more.right <= current.toolbar.right &&
          current.pageScrollWidth <= current.pageClientWidth
        )
      })
      .toBe(true)
    const current = await geometry()
    expect(current.rows).toHaveLength(2)
    expect(current.rows[0].rect.bottom).toBeLessThanOrEqual(
      current.rows[1].rect.top,
    )
    // The closed More panel remains a descendant and can expand the toolbar's own scrollWidth
    // despite being out of normal flow. The user-facing contract is no horizontal PAGE scroll.
    expect(current.pageScrollWidth).toBeLessThanOrEqual(current.pageClientWidth)
    expect(current.more).not.toBeNull()
    expect(current.more!.left).toBeGreaterThanOrEqual(current.toolbar.left)
    expect(current.more!.right).toBeLessThanOrEqual(current.toolbar.right)
    for (const row of current.rows) {
      for (let index = 1; index < row.controls.length; index++) {
        expect(row.controls[index - 1].rect.right).toBeLessThanOrEqual(
          row.controls[index].rect.left,
        )
      }
      expect(new Set(row.controls.map((control) => control.name)).size).toBe(
        row.controls.length,
      )
    }
  }

  await page.setViewportSize({ width: 360, height: 700 })
  await page.evaluate(() => {
    ;(document.querySelector('.vditor-toolbar') as HTMLElement).style.fontSize =
      '28px'
  })
  await expect
    .poll(async () => {
      const current = await geometry()
      return (
        current.more !== null &&
        current.more.right <= current.toolbar.right &&
        current.pageScrollWidth <= current.pageClientWidth
      )
    })
    .toBe(true)
  const zoomed = await geometry()
  expect(zoomed.rows).toHaveLength(2)
  expect(zoomed.pageScrollWidth).toBeLessThanOrEqual(zoomed.pageClientWidth)
  expect(zoomed.more!.right).toBeLessThanOrEqual(zoomed.toolbar.right)

  await page.evaluate(() => {
    ;(document.querySelector('.vditor-toolbar') as HTMLElement).style.fontSize =
      ''
  })
  await page.setViewportSize({ width: 1400, height: 700 })
  await page.locator('[data-type="emoji"]').focus()
  await page.keyboard.press('ArrowRight')
  // Emoji sits at the end of the Upload/Emoji group in row two; the next stop is Insert Before.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.dataset.type))
    .toBe('insert-before')
  await page.locator('[data-type="more"]').focus()
  await page.keyboard.press('ArrowRight')
  // More is the last stop of row two; the roving order wraps to the first stop, Undo.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.dataset.type))
    .toBe('undo')
})

// Task 504 regression: an open `more` menu is STALE once the overflow set changes — a widen
// returns items to the row, so an open menu shows a layout that no longer exists (the returned
// items vanish from it). The overflow pass must close it so the next click re-opens a menu that
// matches the row. Before this fix the panel was left open across the widen and the second click
// on `more` CLOSED it (Vditor's toggle) instead of reopening it — the toolbar-overflow.spec.ts
// (real VS Code) line-144 flake.
test('closes the more panel when overflow changes, and reopens on the next click', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 360, height: 700 })
  await expect(
    page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
    ),
  ).not.toHaveCount(0, { timeout: 5_000 })

  const moreButton = page.locator('.vmde-toolbar-more > [data-type="more"]')
  const panel = page.locator('.vmde-toolbar-more > .vditor-hint')

  // first click opens the panel
  await moreButton.click()
  await expect(panel).toBeVisible()
  await expect(moreButton).toHaveAttribute('aria-expanded', 'true')

  // widen → items return to the row → the open panel is stale → the overflow pass closes it
  await page.setViewportSize({ width: 1400, height: 700 })
  await expect(
    page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
    ),
  ).toHaveCount(0, { timeout: 5_000 })
  await expect(panel).toBeHidden()
  await expect(moreButton).toHaveAttribute('aria-expanded', 'false')

  // second click reopens the (now-consistent) menu
  await moreButton.click()
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-type="settings"]')).toHaveText('Settings')
})

// Task 504 extension: the same stale-open rule covers the OTHER submenu triggers
// (emoji/headings/edit-mode, toolbar-submenu-aria.ts). An open panel must not survive an overflow
// change — it would travel with its item into or out of `more`. Reproduced here with emoji: its
// nested picker is opened INSIDE the more menu, then a widen returns emoji to the row; the picker
// must be closed (not carried back to the row still open).
test('closes an open edit-mode submenu when the overflow set changes', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 80, height: 700 })
  const editModeItem = page.locator(
    '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item:has([data-type="edit-mode"])',
  )
  await expect(editModeItem).toHaveCount(1)

  // Edit mode is movable while Emoji remains direct; open its nested menu inside More.
  await page.locator('.vmde-toolbar-more > [data-type="more"]').click()
  const morePanel = page.locator('.vmde-toolbar-more > .vditor-hint')
  await expect(morePanel).toBeVisible()
  await editModeItem.locator('[data-type="edit-mode"]').focus()
  await page.keyboard.press('Enter')
  const nested = editModeItem.locator('.vditor-hint')
  await expect(nested).toBeVisible()

  // Widen → Edit mode returns to the row → the open panel must close.
  await page.setViewportSize({ width: 1400, height: 700 })
  await expect(
    page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
    ),
  ).toHaveCount(0, { timeout: 5_000 })
  // Edit mode is back in the row; its panel must not travel open.
  const nestedInRow = page.locator(
    '.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item:has(> [data-type="edit-mode"]) .vditor-hint',
  )
  await expect(nestedInRow).toBeHidden()
  await expect(page.locator('[data-type="edit-mode"]')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await page.locator('[data-type="edit-mode"]').click()
  await expect(nestedInRow).toBeVisible()
  expect(await nestedInRow.evaluate((panel) => panel.style.position)).not.toBe(
    'fixed',
  )
})

test('Insert anchor is keyboard-operated from More, returns focus on Cancel/Escape, and is blocked in Preview', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => {
    const outer = (window as any).vditor
    outer.setValue('before target')
    const text = outer.vditor.ir.element.querySelector('p')!.firstChild!
    const range = document.createRange()
    range.setStart(text, 'before '.length)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    outer.vditor.ir.range = range.cloneRange()
  })
  const more = page.locator('.vmde-toolbar-more > [data-type="more"]')
  const anchorAction = page.locator('[data-type="insert-anchor"]')
  await more.focus()
  await page.keyboard.press('Enter')
  await anchorAction.focus()
  await page.keyboard.press('Enter')
  const dialog = page.locator('[data-vmde-anchor-dialog]')
  await expect(dialog).toBeVisible()
  await dialog.locator('input').fill('cancelled')
  await dialog.locator('[data-vmde-anchor-cancel]').click()
  await expect(dialog).toBeHidden()
  await expect(more).toBeFocused()

  await more.focus()
  await page.keyboard.press('Enter')
  await anchorAction.focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(more).toBeFocused()

  await page.locator('[data-type="preview"]').click()
  await more.focus()
  await page.keyboard.press('Enter')
  await anchorAction.focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
})

test('Insert anchor inspects an existing target without exposing a rename action', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => {
    const outer = (window as any).vditor
    outer.setValue('<a name="custom"></a>')
    const marker = outer.vditor.ir.element.firstElementChild!
    const range = document.createRange()
    range.selectNodeContents(marker)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    outer.vditor.ir.range = range.cloneRange()
  })
  const more = page.locator('.vmde-toolbar-more > [data-type="more"]')
  const anchorAction = page.locator('[data-type="insert-anchor"]')
  await more.focus()
  await page.keyboard.press('Enter')
  await anchorAction.focus()
  await page.keyboard.press('Enter')
  const dialog = page.locator('[data-vmde-anchor-dialog]')
  const input = dialog.locator('input')
  await expect(input).toHaveValue('custom')
  await expect(input).toHaveAttribute('readonly', '')
  await expect(dialog).toContainText('Incoming links are unchanged.')
  await expect(dialog.locator('button[type="submit"]')).toHaveCount(0)
  await dialog.locator('[data-vmde-anchor-cancel]').click()
})

test('Insert anchor retains a WYSIWYG repeated-prefix caret through a More pointer journey', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => {
    const outer = (window as any).vditor
    outer.setValue('prefix target prefix target prefix target')
    document.querySelector<HTMLElement>('[data-type="edit-mode"]')?.click()
    document.querySelector<HTMLElement>('button[data-mode="wysiwyg"]')?.click()
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.vditor.currentMode))
    .toBe('wysiwyg')
  await page.evaluate(() => {
    const root = (window as any).vditor.vditor.wysiwyg.element as HTMLElement
    const text = root.querySelector('p')!.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 'prefix target prefix '.length)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    root.focus()
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.locator('.vditor-toolbar [data-type="more"]').click()
  await page.locator('[data-type="insert-anchor"]').click()
  const dialog = page.locator('[data-vmde-anchor-dialog]')
  await dialog.locator('input').fill('wys-repeat')
  await dialog.locator('button[type="submit"]').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(
      'prefix target prefix <a name="wys-repeat"></a>target prefix target\n',
    )
})

test('an overflowed Math submenu keeps keyboard navigation inside its innermost panel', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  // Math sits in the structural group of row two, which gives way after Upload and the Insert
  // pair; it is still in the row at 360 px and in More at 300 px.
  await page.setViewportSize({ width: 300, height: 700 })
  const mathItem = page.locator(
    '.vmde-toolbar-more .vditor-toolbar__item:has(> [data-type="math"])',
  )
  await expect(mathItem).toHaveCount(1)
  await page.locator('.vmde-toolbar-more > [data-type="more"]').click()
  await expect(page.locator('.vmde-toolbar-more > .vditor-hint')).toBeVisible()
  await mathItem.locator('[data-type="math"]').focus()
  await page.keyboard.press('Enter')
  const action = mathItem.locator('[data-type="math-inline-github"]')
  await expect(action).toBeVisible()
  await action.focus()
  const focusedType = () =>
    page.evaluate(() => document.activeElement?.dataset.type)
  // Arrow keys wrap between the two rows of the Math panel itself; focus never leaves it for a
  // More row.
  await page.keyboard.press('ArrowDown')
  await expect.poll(focusedType).toBe('math-block')
  await page.keyboard.press('ArrowDown')
  await expect.poll(focusedType).toBe('math-inline-github')
  await page.keyboard.press('End')
  await expect.poll(focusedType).toBe('math-block')
  await page.keyboard.press('Home')
  await expect.poll(focusedType).toBe('math-inline-github')
})

test('sweeps widths monotonically and holds steady on a threshold', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)

  const overflowCount = () =>
    page.locator('[data-vmde-overflow="true"]').count()

  // Narrowing must never put an item BACK in the row (and widening never take one away): a
  // non-monotonic step is the signature of deciding against a width measured inside the panel.
  const counts: number[] = []
  const total = await page.locator('.vditor-toolbar__item').count()
  for (const width of [1400, 1100, 900, 700, 560, 460, 380, 260, 180]) {
    await page.setViewportSize({ width, height: 700 })
    await page.waitForTimeout(150)
    counts.push(await overflowCount())
    // `more` is the only route to everything else, so it must survive every width…
    await expect(page.locator('.vmde-toolbar-more')).toBeVisible()
    // …and nothing may be lost on the way: every item is either in the row or in the menu.
    const inRow = await page
      .locator('.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item')
      .count()
    expect(inRow + counts[counts.length - 1]).toBe(total)
  }
  for (let i = 1; i < counts.length; i++)
    expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1])

  // Holding one width produces no further moves — the hysteresis band must absorb a width that
  // lands exactly on a give-way threshold.
  await page.setViewportSize({ width: 700, height: 700 })
  await page.waitForTimeout(200)
  const settled = await overflowCount()
  await page.waitForTimeout(600)
  expect(await overflowCount()).toBe(settled)
})

test('overflowed rows are labelled once and reachable by keyboard', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 180, height: 700 })
  await expect(
    page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]:has([data-type="bold"])',
    ),
  ).toHaveCount(1)
  // Row one gives way from its end, so Headings survives at 180 px next to Undo and Redo while the
  // inline-formatting group has already moved into More.
  await expect(
    page.locator(
      '.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item > [data-type="headings"]',
    ),
  ).toHaveCount(1)

  // The panel is display:none until opened, so its rows only enter the a11y tree (and become
  // focusable) once `more` is triggered — from the keyboard, via the focused button.
  const moreButton = page.locator('.vmde-toolbar-more > [data-type="more"]')
  await expect(moreButton).toHaveAttribute('aria-expanded', 'false')
  await moreButton.focus()
  await page.keyboard.press('Enter')
  const panel = page.locator('.vmde-toolbar-more > .vditor-hint')
  await expect(panel).toBeVisible()
  await expect(moreButton).toHaveAttribute('aria-expanded', 'true')
  await expect(moreButton).toHaveAttribute('aria-haspopup', 'menu')

  // F5's open question: the row label is CSS generated content (`::after { content: attr(aria-label) }`)
  // on a button that already carries that aria-label. aria-label wins the accessible-name computation
  // outright, so the row is announced ONCE — asserted here rather than assumed.
  //
  // Assert that on the accessible NAME, not on raw occurrences of the string: an aria snapshot prints a
  // node's name (`- button "…"`) AND its child text nodes separately, and the visible label IS a child
  // text node (the ::after). Counting the bare string therefore always reads 2 and says nothing about
  // how often the row is announced. The second assertion pins the other half of the same property —
  // visible text identical to the accessible name, i.e. WCAG 2.5.3 Label in Name.
  const headingsLabel = await page
    .locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item [data-type="bold"]',
    )
    .getAttribute('aria-label')
  const snapshot = await panel.ariaSnapshot()
  const escaped = (headingsLabel ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  expect(
    snapshot.match(new RegExp(`- button "${escaped}"`, 'g'))?.length ?? 0,
    'the row carries the label as its accessible name exactly once',
  ).toBe(1)
  expect(
    snapshot.match(new RegExp(`- text: ${escaped}`, 'g'))?.length ?? 0,
    'the visible label matches the accessible name (WCAG 2.5.3)',
  ).toBe(1)

  // Arrow keys walk the menu rows the same way they walk the row (H-subset of task 492).
  const focusedType = () =>
    page.evaluate(() => document.activeElement?.getAttribute('data-type'))
  await page
    .locator('.vmde-toolbar-more > .vditor-hint > * > button')
    .first()
    .focus()
  const first = await focusedType()
  await page.keyboard.press('ArrowDown')
  const second = await focusedType()
  expect(second).not.toBe(first)
  await page.keyboard.press('End')
  const last = await focusedType()
  expect(last).not.toBe(second)
  await page.keyboard.press('Home')
  expect(await focusedType()).toBe(first)
})

const readRowNames = (page: import('@playwright/test').Page, row: 1 | 2) =>
  page
    .locator(
      `.vditor-toolbar > .vmde-toolbar-row[data-vmde-toolbar-row="${row}"] > .vditor-toolbar__item`,
    )
    .evaluateAll((items) =>
      items
        .map((item) =>
          item.querySelector(':scope > [data-type]')?.getAttribute('data-type'),
        )
        .filter((name): name is string => Boolean(name)),
    )

// `yieldOrder` lists the groups in the order they leave the row. A group still in the row implies
// every group that leaves after it is in the row too, and groups move whole.
const expectGivesWayFromEnd = (names: string[], yieldOrder: string[][]) => {
  let laterPresent = true
  for (let index = yieldOrder.length - 1; index >= 0; index--) {
    const group = yieldOrder[index]
    if (group.length === 0) continue
    const present = group.filter((name) => names.includes(name))
    expect([0, group.length]).toContain(present.length)
    if (present.length > 0) expect(laterPresent).toBe(true)
    else laterPresent = false
  }
}

test('row-two groups give way from the row end in the decided order', async ({
  page,
}) => {
  // Emoji and More are pinned and never leave; Edit In VS Code and Edit Mode give way last.
  const navigation = ['navigate-back', 'wiki-pages']
  const yieldOrder = (wikiEnabled: boolean) => [
    wikiEnabled ? navigation : [],
    ['outline', 'preview'],
    ['insert-before', 'insert-after'],
    ['upload'],
    ['quote', 'callout', 'details', 'code', 'math', 'table', 'line'],
    ['edit-in-vscode', 'edit-mode'],
  ]
  for (const wikiEnabled of [true, false]) {
    await page.goto(
      `/toolbar-overflow.html?wiki=${wikiEnabled ? 'enabled' : 'disabled'}`,
    )
    await page.waitForFunction(() => (window as any).__ready === true)
    const survivors: string[][] = []
    for (const width of [1400, 600, 500, 420, 360, 300, 220, 160, 80]) {
      await page.setViewportSize({ width, height: 700 })
      await page.waitForTimeout(250)
      survivors.push(await readRowNames(page, 2))
      await expect(page.locator('.vmde-toolbar-more')).toBeVisible()
    }
    for (const names of survivors) {
      expect(names).toContain('more')
      expect(names).toContain('emoji')
      expectGivesWayFromEnd(names, yieldOrder(wikiEnabled))
    }
    // The widest width keeps the whole row; the narrowest has shed the first and structural groups.
    expect(survivors[0]).toContain('outline')
    expect(survivors[survivors.length - 1]).not.toContain('outline')
    expect(survivors[survivors.length - 1]).not.toContain('quote')
  }
})

// Row one gives way from its end too: Indent and lists leave first, History stays visible longest.
test('row-one groups give way from the row end and History stays visible', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  const yieldOrder = [
    ['outdent', 'indent'],
    ['list', 'ordered-list', 'check'],
    ['link'],
    ['subscript', 'superscript'],
    ['bold', 'italic', 'underline', 'strike', 'inline-code'],
    ['headings'],
  ]
  const survivors: string[][] = []
  for (const width of [1400, 560, 500, 420, 360, 300, 240, 180, 80]) {
    await page.setViewportSize({ width, height: 700 })
    await page.waitForTimeout(250)
    survivors.push(await readRowNames(page, 1))
  }
  for (const names of survivors) {
    expect(names).toContain('undo')
    expect(names).toContain('redo')
    expectGivesWayFromEnd(names, yieldOrder)
  }
  expect(survivors[0]).toContain('indent')
  expect(survivors[survivors.length - 1]).not.toContain('indent')
  expect(survivors[survivors.length - 1]).not.toContain('bold')
})

test('a movable edit-mode panel opens inside More without a stray arrow', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 80, height: 700 })
  const editModeItem = page.locator(
    '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item:has([data-type="edit-mode"])',
  )
  await expect(editModeItem).toHaveCount(1)

  await page.locator('.vmde-toolbar-more > [data-type="more"]').click()
  await expect(page.locator('.vmde-toolbar-more > .vditor-hint')).toBeVisible()
  // The nested panel is a .vditor-panel, which Vditor's own `.vditor-hint .vditor-hint` flyout rule
  // does NOT cover — F4. Our added rule has to place it, and the `--arrow` must be gone (Vditor
  // drops that class for genuine level-2 items).
  expect(await editModeItem.locator('.vditor-panel--arrow').count()).toBe(0)

  await editModeItem.locator('[data-type="edit-mode"]').focus()
  await page.keyboard.press('Enter')
  const nested = editModeItem.locator('.vditor-hint')
  await expect(nested).toBeVisible()
  const box = await nested.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  // Flown out to a real on-screen position, not stacked at 0/0 or pushed off the edge.
  expect(box?.width ?? 0).toBeGreaterThan(0)
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
    (viewport?.width ?? 0) + 1,
  )
})

test('a nested edit-mode hint inside More stays reachable at the viewport edge', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 80, height: 180 })

  const more = page.locator('.vmde-toolbar-more')
  await more.locator('[data-type="more"]').click()
  const modeItem = more.locator(
    '.vditor-hint > .vditor-toolbar__item:has([data-type="edit-mode"])',
  )
  await expect(modeItem).toHaveCount(1)
  await modeItem.locator('[data-type="edit-mode"]').focus()
  await page.keyboard.press('Enter')
  const modePanel = modeItem.locator('.vditor-hint')
  await expect(modePanel).toBeVisible()
  const box = await modePanel.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0)
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
    viewport?.width ?? 0,
  )
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
    viewport?.height ?? 0,
  )

  await page.setViewportSize({ width: 1400, height: 700 })
  const topLevelMode = page.locator(
    '.vmde-toolbar-row > .vditor-toolbar__item:has(> [data-type="edit-mode"])',
  )
  await expect(topLevelMode).toHaveCount(1)
  await topLevelMode.locator('[data-type="edit-mode"]').click()
  const topLevelPanel = topLevelMode.locator(':scope > .vditor-hint')
  await expect(topLevelPanel).toBeVisible()
  expect(
    await topLevelPanel.evaluate((panel) => panel.style.position),
  ).not.toBe('fixed')
})

test('toolbar labels (names only) and custom icons stay usable', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)

  await expect(page.locator('[data-type="line"]')).toHaveAttribute(
    'aria-label',
    /Horizontal Rule/,
  )
  await expect(page.locator('[data-type="ordered-list"]')).toHaveAttribute(
    'aria-label',
    /Numbered List/,
  )
  // Task 580 CP3-2: names only, with no key.
  await expect(page.locator('[data-type="redo"]')).toHaveAttribute(
    'aria-label',
    'Redo',
  )

  const customIconSizes = await page
    .locator('[data-type="edit-in-vscode"] svg')
    .evaluate((svg) => ({
      width: (svg as SVGElement).getBoundingClientRect().width,
      height: (svg as SVGElement).getBoundingClientRect().height,
    }))
  expect(customIconSizes).toEqual({ width: 16, height: 16 })

  await page.locator('[data-type="more"]').click()
  const panel = page.locator('.vmde-toolbar-more > .vditor-hint')
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-type="settings"]')).toHaveText('Settings')
  await expect(panel.locator('[data-type="info"]')).toHaveText('About Vditor')
  await expect(panel.locator('[data-type="about"]')).toHaveText('About VMDE')
})

// Task 492 Phase 5: aria-haspopup/aria-expanded + menu semantics for the toolbar's other three
// submenu triggers (emoji/headings/edit-mode) — the H-subset above only covers `more`.
test('emoji owns a searchable dialog while headings and edit-mode keep menu semantics', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })

  for (const name of ['headings', 'edit-mode']) {
    const button = page.locator(`[data-type="${name}"]`)
    await expect(button).toHaveAttribute('aria-haspopup', 'menu')
    await expect(button).toHaveAttribute('aria-expanded', 'false')
  }
  const emoji = page.locator('[data-type="emoji"]')
  await expect(emoji).toHaveAttribute('aria-haspopup', 'dialog')
  await expect(emoji).toHaveAttribute('aria-expanded', 'false')

  // headings: a plain vditor-hint panel, rows are direct <button>s.
  await page.locator('[data-type="headings"]').click()
  await expect(page.locator('[data-type="headings"]')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  const headingsPanel = page.locator(
    '.vditor-toolbar__item:has(> [data-type="headings"]) > .vditor-hint',
  )
  await expect(headingsPanel).toHaveAttribute('role', 'menu')
  await expect(headingsPanel.locator('[data-tag="h1"]')).toHaveAttribute(
    'role',
    'menuitem',
  )
  await emoji.click()

  const picker = page.locator('.vmde-emoji-picker')
  await expect(picker.locator('input[type="search"]')).toBeFocused()
  await expect(picker.locator('.vmde-emoji-picker__tile')).not.toHaveCount(0)
  await picker.locator('input[type="search"]').press('ArrowDown')
  await expect(picker.locator('.vmde-emoji-picker__tile').first()).toBeFocused()
  const firstTile = picker.locator('.vmde-emoji-picker__tile').first()
  await firstTile.press('ArrowRight')
  await expect(picker.locator('.vmde-emoji-picker__tile').nth(1)).toBeFocused()
  await firstTile.press('End')
  const keyboardScroll = await picker.evaluate((panel) => {
    const results = panel.querySelector(
      '.vmde-emoji-picker__results',
    ) as HTMLElement
    const focused = document.activeElement as HTMLElement
    const resultsBox = results.getBoundingClientRect()
    const focusedBox = focused.getBoundingClientRect()
    return {
      scrolled: results.scrollTop > 0,
      visible:
        focusedBox.top >= resultsBox.top &&
        focusedBox.bottom <= resultsBox.bottom,
    }
  })
  expect(keyboardScroll).toEqual({ scrolled: true, visible: true })
  await picker.locator('input[type="search"]').fill('bags under eyes')
  await expect(picker.locator('.vmde-emoji-picker__tile')).toHaveCount(1)
  await picker.locator('input[type="search"]').press('Escape')
  await expect(emoji).toHaveAttribute('aria-expanded', 'false')
})

test('emoji picker owns tile hover and clear interactions without Vditor panel handlers', async ({
  page,
}) => {
  const pageErrors: Error[] = []
  page.on('pageerror', (error) => pageErrors.push(error))
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.locator('[data-type="emoji"]').click()
  const picker = page.locator('.vmde-emoji-picker')
  await picker.locator('.vmde-emoji-picker__tile').first().hover()
  await picker.locator('input[type="search"]').fill('bags under eyes')
  await picker.getByRole('button', { name: 'Clear emoji search' }).click()
  await expect(picker.locator('input[type="search"]')).toHaveValue('')
  expect(pageErrors).toEqual([])
})

test('emoji picker keeps transparent tiles and promotes successful selections to recents', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(editor)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  const emoji = page.locator('[data-type="emoji"]')
  await emoji.click()
  const picker = page.locator('.vmde-emoji-picker')
  await expect(
    picker.getByRole('heading', { name: 'Recently used' }),
  ).toBeVisible()
  await expect(picker.getByText('No recently used emoji yet.')).toBeVisible()
  const catalogTile = picker
    .locator('[data-emoji-grid="catalog"] .vmde-emoji-picker__tile')
    .first()
  expect(
    await catalogTile.evaluate(
      (tile) => getComputedStyle(tile).backgroundColor,
    ),
  ).toBe('rgba(0, 0, 0, 0)')
  const selectedName = await catalogTile.getAttribute('aria-label')
  await page.evaluate(() => {
    ;(window as any).vscode = {
      postMessage: () => {
        throw new Error('storage unavailable')
      },
    }
  })
  await catalogTile.click()
  await emoji.click()
  const recentTile = picker
    .locator('[data-emoji-grid="recent"] .vmde-emoji-picker__tile')
    .first()
  await expect(recentTile).toHaveAttribute('aria-label', selectedName ?? '')
  expect(
    await recentTile.evaluate((tile) => getComputedStyle(tile).backgroundColor),
  ).toBe('rgba(0, 0, 0, 0)')
  await picker.locator('input[type="search"]').press('ArrowDown')
  await expect(recentTile).toBeFocused()
  await recentTile.press('ArrowDown')
  await expect(
    picker
      .locator('[data-emoji-grid="catalog"] .vmde-emoji-picker__tile')
      .first(),
  ).toBeFocused()
  await picker.locator('input[type="search"]').fill('no-such-recent')
  await expect(
    picker.getByText('No matching recently used emoji.'),
  ).toBeVisible()
})

test('emoji picker updates its expanded state when an overflow reflow closes its panel', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })
  const emoji = page.locator('[data-type="emoji"]')
  const picker = page.locator('.vmde-emoji-picker')
  await emoji.click()
  await expect(emoji).toHaveAttribute('aria-expanded', 'true')
  await page.setViewportSize({ width: 80, height: 700 })
  await expect(picker).toBeHidden()
  await expect(emoji).toHaveAttribute('aria-expanded', 'false')
})

test('emoji picker scrolls its categorized grid inside a narrow toolbar without page overflow', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 280, height: 700 })
  await page.locator('[data-type="emoji"]').click()
  const picker = page.locator('.vmde-emoji-picker')
  const geometry = await picker.evaluate((panel) => {
    const results = panel.querySelector(
      '.vmde-emoji-picker__results',
    ) as HTMLElement
    const box = panel.getBoundingClientRect()
    results.scrollTop = results.scrollHeight
    return {
      clientWidth: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      panelLeft: box.left,
      panelRight: box.right,
      resultsClientHeight: results.clientHeight,
      resultsScrollHeight: results.scrollHeight,
      resultsScrollTop: results.scrollTop,
    }
  })
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.clientWidth)
  expect(geometry.panelLeft).toBeGreaterThanOrEqual(0)
  expect(geometry.panelRight).toBeLessThanOrEqual(geometry.clientWidth)
  expect(geometry.resultsScrollHeight).toBeGreaterThan(
    geometry.resultsClientHeight,
  )
  expect(geometry.resultsScrollTop).toBeGreaterThan(0)
})

test('emoji picker retains its narrow viewport correction after closing and reopening', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 280, height: 700 })
  const trigger = page.locator('[data-type="emoji"]')
  const picker = page.locator('.vmde-emoji-picker')
  await trigger.click()
  await picker.locator('input[type="search"]').press('Escape')
  await expect(trigger).toBeFocused()
  await trigger.click()
  const bounds = await picker.evaluate((panel) => {
    const box = panel.getBoundingClientRect()
    return { left: box.left, right: box.right, width: innerWidth }
  })
  expect(bounds.left).toBeGreaterThanOrEqual(0)
  expect(bounds.right).toBeLessThanOrEqual(bounds.width)
})

test('emoji picker replaces a retained editor selection with one complete Unicode sequence', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    editor.focus()
    const text = editor.firstChild
    if (!text) throw new Error('editor text missing')
    const range = document.createRange()
    range.selectNodeContents(editor)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await page.locator('[data-type="emoji"]').click()
  const picker = page.locator('.vmde-emoji-picker')
  await picker.locator('input[type="search"]').fill('bags under eyes')
  await picker.locator('.vmde-emoji-picker__tile').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('🫩\n')
  // Emoji selection follows Vditor's debounced render path; wait for its transaction to become
  // undoable instead of racing Ctrl+Z ahead of the mode-specific undo record.
  await expect(page.locator('[data-type="undo"]')).not.toHaveClass(
    /vditor-menu--disabled/,
  )
  await page.locator('[data-type="undo"]').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('toolbar overflow\n')
  await page.locator('[data-type="redo"]').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('🫩\n')
})

test('emoji picker preserves a Tab-captured bookmark when toolbar focus loses the live range', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let text = walker.nextNode() as Text | null
    while (text && !text.data.includes('overflow'))
      text = walker.nextNode() as Text | null
    if (!text) throw new Error('editor text missing')
    const start = text.data.indexOf('overflow')
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, start + 'overflow'.length)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
  })
  const trigger = page.locator('[data-type="emoji"]')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  for (let step = 0; step < 32; step++) {
    if (await trigger.evaluate((button) => document.activeElement === button))
      break
    await page.keyboard.press('ArrowRight')
  }
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Space')
  const picker = page.locator('.vmde-emoji-picker')
  await picker.locator('input[type="search"]').fill('bags under eyes')
  await picker.locator('.vmde-emoji-picker__tile').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('toolbar 🫩\n')
})

test('emoji picker commits the pointerdown source bookmark after later focus handlers rebuild the DOM', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => {
    const outer = (window as any).vditor
    const editor = outer.vditor.ir.element as HTMLElement
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let text = walker.nextNode() as Text | null
    while (text && !text.data.includes('overflow'))
      text = walker.nextNode() as Text | null
    if (!text) throw new Error('toolbar overflow source text missing')
    const start = text.data.indexOf('overflow')
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, start + 'overflow'.length)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    document
      .querySelector<HTMLElement>('[data-type="emoji"]')!
      .addEventListener(
        'pointerdown',
        () => {
          const equivalent = editor.innerHTML
          editor.replaceChildren()
          editor.insertAdjacentHTML('afterbegin', equivalent)
          const reset = document.createRange()
          reset.setStart(editor, 0)
          reset.collapse(true)
          selection.removeAllRanges()
          selection.addRange(reset)
        },
        { once: true },
      )
  })

  await page.locator('[data-type="emoji"]').click()
  const picker = page.locator('.vmde-emoji-picker')
  await picker.locator('input[type="search"]').fill('bags under eyes')
  await picker.locator('.vmde-emoji-picker__tile').click()

  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('toolbar 🫩\n')
})

for (const mode of ['wysiwyg', 'sv'] as const) {
  test(`emoji picker keeps an exact one-step source transaction in ${mode}`, async ({
    page,
  }) => {
    await page.goto('/toolbar-overflow.html')
    await page.waitForFunction(() => (window as any).__ready === true)
    await page.evaluate((currentMode) => {
      const inner = (window as any).vditor.vditor
      inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
      document
        .querySelector<HTMLElement>(`button[data-mode="${currentMode}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, mode)
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).vditor.vditor.currentMode),
      )
      .toBe(mode)
    const baseline = await page.evaluate(() =>
      (window as any).vditor.getValue(),
    )
    // This harness has no edit-sync adapter, so its raw SV getValue includes Vditor's terminal
    // caret line. Real host-byte coverage uses edit-sync's SV serializer and remains one newline.
    const inserted = mode === 'sv' ? '🫩\n\n' : '🫩\n'
    await page.evaluate(() => {
      const inner = (window as any).vditor.vditor
      const editor = inner[inner.currentMode].element as HTMLElement
      editor.focus()
      const range = document.createRange()
      range.selectNodeContents(editor)
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    await page.locator('[data-type="emoji"]').click()
    const picker = page.locator('.vmde-emoji-picker')
    await picker.locator('input[type="search"]').fill('bags under eyes')
    await picker.locator('.vmde-emoji-picker__tile').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toBe(inserted)
    await page.locator('[data-type="undo"]').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toBe(baseline)
    await page.locator('[data-type="redo"]').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toBe(inserted)
  })
}

// Task 492 Phase 5, Part B: `upload` is now a real <button> (MenuItem.ts's div exception dropped
// via the build-time patch, esbuild-shared.mjs patchUploadTagName) with the `<input type=file>`
// moved to a hidden sibling (patchUploadHiddenInput) instead of nested inside it.
test('upload is a semantic button that still opens a file picker, and disabled state still blocks it', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)

  const uploadButton = page.locator('[data-type="upload"]')
  await expect(uploadButton).toHaveJSProperty('tagName', 'BUTTON')
  // The file input must NOT be a descendant of the button (that would be invalid nesting and,
  // via input.click()'s bubbling synthetic click, an infinite re-entrant loop into this same
  // listener — see patchUploadHiddenInput's comment in esbuild-shared.mjs).
  await expect(uploadButton.locator('input[type="file"]')).toHaveCount(0)
  const hiddenInput = page.locator(
    '.vditor-toolbar__item:has(> [data-type="upload"]) > input[type="file"]',
  )
  await expect(hiddenInput).toHaveCount(1)
  await expect(hiddenInput).toBeHidden()
  await expect(hiddenInput).toHaveJSProperty('tabIndex', -1)

  const chooserPromise = page.waitForEvent('filechooser')
  await uploadButton.click()
  const chooser = await chooserPromise
  expect(chooser).toBeTruthy()

  // The disabled guard (Upload.ts's own CLASS_MENU_DISABLED check) must still block the click —
  // moving the input out must not have bypassed it.
  await page.evaluate(() => {
    document
      .querySelector('[data-type="upload"]')
      ?.classList.add('vditor-menu--disabled')
  })
  let secondChooserFired = false
  page.once('filechooser', () => {
    secondChooserFired = true
  })
  await uploadButton.click()
  await page.waitForTimeout(200)
  expect(secondChooserFired).toBe(false)
})

const visibleRowTokens = (page: import('@playwright/test').Page) =>
  page.locator('.vditor-toolbar').evaluate((toolbar) =>
    Array.from(
      toolbar.querySelectorAll<HTMLElement>(':scope > .vmde-toolbar-row'),
    ).map((row) =>
      Array.from(row.children)
        .filter((child) => getComputedStyle(child).display !== 'none')
        .map((child) =>
          child.classList.contains('vditor-toolbar__divider')
            ? '|'
            : (child
                .querySelector(':scope > [data-type]')
                ?.getAttribute('data-type') ?? ''),
        ),
    ),
  )

const expectNoStraySeparators = (rows: string[][]) => {
  expect(rows).toHaveLength(2)
  for (const row of rows) {
    expect(row.length).toBeGreaterThan(0)
    expect(row[0]).not.toBe('|')
    expect(row[row.length - 1]).not.toBe('|')
    for (let index = 1; index < row.length; index++)
      expect(row[index - 1] === '|' && row[index] === '|').toBe(false)
  }
}

const switchMode = async (
  page: import('@playwright/test').Page,
  mode: string,
) => {
  await page.evaluate((target) => {
    document.querySelector<HTMLElement>('[data-type="edit-mode"]')?.click()
    document
      .querySelector<HTMLElement>(`button[data-mode="${target}"]`)
      ?.click()
  }, mode)
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.vditor.currentMode))
    .toBe(mode)
}

test('Source mode and wiki-off rows hold no leading, trailing or doubled separators', async ({
  page,
}) => {
  // Vditor hides Outdent, Indent, Outline, Insert Before and Insert After in Source mode.
  const svRowOne = [
    ...OWNER_ROW_ONE.slice(
      0,
      OWNER_ROW_ONE.indexOf('|', OWNER_ROW_ONE.indexOf('check')),
    ),
    'collapse-toolbar',
  ]
  const svRowTwo = (wikiEnabled: boolean) => [
    'quote',
    'callout',
    'details',
    'code',
    'math',
    'table',
    'line',
    '|',
    'upload',
    'emoji',
    '|',
    'preview',
    '|',
    ...(wikiEnabled ? ['navigate-back', 'wiki-pages', '|'] : []),
    'edit-in-vscode',
    'edit-mode',
    'more',
  ]

  for (const wikiEnabled of [true, false]) {
    await page.goto(
      `/toolbar-overflow.html?wiki=${wikiEnabled ? 'enabled' : 'disabled'}`,
    )
    await page.waitForFunction(() => (window as any).__ready === true)
    await page.setViewportSize({ width: 1400, height: 700 })

    // Switching mode leaves the overflow set empty and unchanged; the separators must still follow
    // the newly hidden controls.
    await switchMode(page, 'sv')
    await expect
      .poll(() => visibleRowTokens(page))
      .toEqual([svRowOne, svRowTwo(wikiEnabled)])

    for (const width of [1000, 560, 500, 420, 360, 300, 240, 180, 80]) {
      await page.setViewportSize({ width, height: 700 })
      await page.waitForTimeout(250)
      expectNoStraySeparators(await visibleRowTokens(page))
    }
    await page.setViewportSize({ width: 1400, height: 700 })
    await expect
      .poll(() => visibleRowTokens(page))
      .toEqual([svRowOne, svRowTwo(wikiEnabled)])

    // Back to a Markdown editing mode restores the full approved rows.
    await switchMode(page, 'ir')
    const rowTwo = wikiEnabled
      ? OWNER_ROW_TWO
      : [
          ...OWNER_ROW_TWO.slice(0, OWNER_ROW_TWO.indexOf('navigate-back') - 1),
          ...OWNER_ROW_TWO.slice(OWNER_ROW_TWO.indexOf('edit-in-vscode') - 1),
        ]
    await expect
      .poll(() => visibleRowTokens(page))
      .toEqual([OWNER_ROW_ONE, rowTwo])

    // The same switch with a non-empty, unchanged overflow set.
    await page.setViewportSize({ width: 420, height: 700 })
    await page.waitForTimeout(250)
    expectNoStraySeparators(await visibleRowTokens(page))
    await switchMode(page, 'sv')
    expectNoStraySeparators(await visibleRowTokens(page))
    await switchMode(page, 'ir')
    expectNoStraySeparators(await visibleRowTokens(page))
  }
})

test('keyboard traversal follows the visual order and starts at Undo', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html?wiki=enabled')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })

  const visual = [...OWNER_ROW_ONE, ...OWNER_ROW_TWO].filter(
    (name) => name !== '|',
  )
  const focusedType = () =>
    page.evaluate(() => document.activeElement?.getAttribute('data-type'))

  // The one tabbable stop is Undo, and Tab from the start of the page reaches it.
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await page.keyboard.press('Tab')
  await expect.poll(focusedType).toBe('undo')

  const walked: string[] = ['undo']
  for (let step = 1; step < visual.length; step++) {
    await page.keyboard.press('ArrowRight')
    walked.push((await focusedType()) ?? '')
  }
  expect(walked).toEqual(visual)
  await page.keyboard.press('ArrowRight')
  await expect.poll(focusedType).toBe('undo')

  // ArrowLeft walks the same order backwards, wrapping from Undo to More.
  await page.keyboard.press('ArrowLeft')
  await expect.poll(focusedType).toBe('more')
})

// Task 631: the collapse toggle hides the whole toolbar except itself, and a later expand restores
// the exact layout (hidden items report width 0, so the overflow pass must re-measure).
const COLLAPSE_TOGGLE = '.vditor-toolbar [data-type="collapse-toolbar"]'

const overflowSet = (page: import('@playwright/test').Page) =>
  page
    .locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type]',
    )
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('data-type')),
    )

const toolbarHeight = (page: import('@playwright/test').Page) =>
  page
    .locator('.vditor-toolbar')
    .evaluate((toolbar) => Math.round(toolbar.getBoundingClientRect().height))

for (const width of [1400, 420]) {
  test(`collapse then expand at ${width}px restores the same rows and overflow set`, async ({
    page,
  }) => {
    await page.goto('/toolbar-overflow.html?wiki=enabled')
    await page.waitForFunction(() => (window as any).__ready === true)
    await page.setViewportSize({ width, height: 700 })
    await page.waitForTimeout(250)
    const rowsBefore = await visibleRowTokens(page)
    const overflowBefore = await overflowSet(page)
    const heightBefore = await toolbarHeight(page)
    if (width < 800) expect(overflowBefore.length).toBeGreaterThan(0)

    const toggle = page.locator(COLLAPSE_TOGGLE)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // Only the toggle stays visible, in one slim strip (F1: 70% of a row).
    await expect(
      page.locator('.vditor-toolbar [data-type]:visible'),
    ).toHaveCount(1)
    await expect(toggle).toBeVisible()
    expect(await toolbarHeight(page)).toBeLessThan(heightBefore)
    // F1: the strip is 70% of one expanded row (35 px), not a full row.
    expect(await toolbarHeight(page)).toBeLessThanOrEqual(26)
    expect(await toolbarHeight(page)).toBeGreaterThanOrEqual(23)
    await expect(page.locator('.vmde-toolbar-row:visible')).toHaveCount(1)
    // The toggle sits at the trailing edge of the strip.
    const edges = await page.evaluate(() => {
      const strip = document.querySelector('.vditor-toolbar') as HTMLElement
      const button = document.querySelector(
        '.vditor-toolbar [data-type="collapse-toolbar"]',
      ) as HTMLElement
      return {
        gap:
          strip.getBoundingClientRect().right -
          button.getBoundingClientRect().right,
      }
    })
    expect(edges.gap).toBeLessThan(24)

    // A resize while collapsed must not poison the overflow measurements.
    await page.setViewportSize({ width: width + 40, height: 700 })
    await page.setViewportSize({ width, height: 700 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => visibleRowTokens(page)).toEqual(rowsBefore)
    await expect.poll(() => overflowSet(page)).toEqual(overflowBefore)
    await expect.poll(() => toolbarHeight(page)).toBe(heightBefore)
  })
}

// Task 631 follow-up F1 (Owner request 2026-10-15): the toggle is 30% smaller than a normal toolbar
// button and the collapsed strip is 30% shorter than one expanded row. Expected ratio 0.7 (+-1 px).
test('F1: the collapse toggle and the collapsed strip are 70% of the normal sizes', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html?wiki=enabled')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })
  await page.waitForTimeout(250)
  const measure = () =>
    page.evaluate(() => {
      const box = (el: Element | null) => {
        const r = (el as HTMLElement).getBoundingClientRect()
        return { w: r.width, h: r.height }
      }
      const toggle = document.querySelector(
        '.vditor-toolbar [data-type="collapse-toolbar"]',
      ) as HTMLElement
      const bold = document.querySelector(
        '.vditor-toolbar [data-type="bold"]',
      ) as HTMLElement
      const row1 = document.querySelector(
        '.vditor-toolbar .vmde-toolbar-row[data-vmde-toolbar-row="1"]',
      )
      const row2 = document.querySelector(
        '.vditor-toolbar .vmde-toolbar-row[data-vmde-toolbar-row="2"]',
      )
      return {
        toggle: box(toggle),
        toggleIcon: box(toggle.querySelector('svg')),
        bold: box(bold),
        boldIcon: box(bold.querySelector('svg')),
        row1: box(row1),
        row2: box(row2),
        toolbar: box(document.querySelector('.vditor-toolbar')),
        toggleCenterY:
          toggle.getBoundingClientRect().top +
          toggle.getBoundingClientRect().height / 2,
        toolbarTop: document
          .querySelector('.vditor-toolbar')!
          .getBoundingClientRect().top,
      }
    })
  const expanded = await measure()
  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1)

  // Toggle box and icon: 70% of a normal toolbar button's, in the expanded state.
  near(expanded.toggle.w, expanded.bold.w * 0.7)
  near(expanded.toggle.h, expanded.bold.h * 0.7)
  near(expanded.toggleIcon.w, expanded.boldIcon.w * 0.7)
  near(expanded.toggleIcon.h, expanded.boldIcon.h * 0.7)

  const toggle = page.locator(COLLAPSE_TOGGLE)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  const collapsed = await measure()
  // Same sizes in the collapsed state; the strip is 70% of one expanded row.
  near(collapsed.toggle.w, expanded.bold.w * 0.7)
  near(collapsed.toggle.h, expanded.bold.h * 0.7)
  near(collapsed.toggleIcon.w, expanded.boldIcon.w * 0.7)
  near(collapsed.toolbar.h, expanded.row1.h * 0.7)
  // Vertically centred in the strip.
  near(collapsed.toggleCenterY - collapsed.toolbarTop, collapsed.toolbar.h / 2)

  // Expanded layout heights are unchanged by the collapse and expand round trip.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect
    .poll(async () => {
      const again = await measure()
      return [again.row1.h, again.row2.h, again.toolbar.h]
    })
    .toEqual([expanded.row1.h, expanded.row2.h, expanded.toolbar.h])

  // The smaller toggle still toggles by keyboard (Enter and Space) and shows a focus ring.
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Space')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const ring = await toggle.evaluate((el) => {
    const cs = getComputedStyle(el)
    return (
      document.activeElement === el &&
      el.matches(':focus-visible') &&
      cs.outlineStyle !== 'none' &&
      Number.parseFloat(cs.outlineWidth) > 0
    )
  })
  expect(ring).toBe(true)
})

test('an open More menu closes when the toolbar collapses', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html?wiki=enabled')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 360, height: 700 })
  const moreButton = page.locator('.vmde-toolbar-more > [data-type="more"]')
  const panel = page.locator('.vmde-toolbar-more > .vditor-hint')
  await moreButton.click()
  await expect(panel).toBeVisible()
  await page.locator(COLLAPSE_TOGGLE).click()
  await expect(panel).toBeHidden()
  await expect(moreButton).toHaveAttribute('aria-expanded', 'false')
  await page.locator(COLLAPSE_TOGGLE).click()
  await expect(panel).toBeHidden()
})

test('an open Headings menu closes when the toolbar collapses', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html?wiki=enabled')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })
  const headings = page.locator('.vditor-toolbar [data-type="headings"]')
  await headings.click()
  const panel = page.locator(
    '.vditor-toolbar__item:has(> [data-type="headings"]) > .vditor-hint',
  )
  await expect(panel).toBeVisible()
  await page.locator(COLLAPSE_TOGGLE).click()
  await expect(panel).toBeHidden()
})

test('a mouse click on the collapse toggle keeps the caret, selection and scroll position', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html?wiki=enabled')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 500 })
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n\n')
  await page.evaluate((value) => (window as any).vditor.setValue(value), lines)
  // The harness toolbar scrolls with the page, so the browser's scroll anchoring would move
  // scrollTop to keep content in place when the strip changes height. Turn it off to assert that
  // nothing in the toggle path scrolls on its own.
  await page.addStyleTag({ content: 'body { overflow-anchor: none; }' })
  const snapshot = () =>
    page.evaluate(() => {
      const root = document.querySelector(
        '.vditor-ir .vditor-reset',
      ) as HTMLElement
      const selection = getSelection()
      const scroller = document.body
      const sources = [root, root.parentElement as HTMLElement, scroller]
      return {
        selected: selection?.toString() ?? '',
        anchorOffset: selection?.anchorOffset ?? -1,
        focusOffset: selection?.focusOffset ?? -1,
        anchorText: selection?.anchorNode?.textContent ?? '',
        inEditor: Boolean(
          selection?.anchorNode && root.contains(selection.anchorNode),
        ),
        focusInEditor: Boolean(document.activeElement?.closest('.vditor-ir')),
        scroll: sources.map((el) => el.scrollTop),
      }
    })
  await page.locator('.vditor-ir .vditor-reset').evaluate((root) => {
    const target = root.querySelectorAll('p')[40] as HTMLElement
    target.scrollIntoView()
    const text = target.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 1)
    range.setEnd(text, 4)
    ;(root as HTMLElement).focus()
    const selection = getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.body.scrollTop = 12
  })
  const before = await snapshot()
  expect(before.selected).toBe('ine')
  expect(before.focusInEditor).toBe(true)
  expect(before.scroll[2]).toBeGreaterThan(0)

  // A raw mouse click at the toggle's on-screen position: Playwright's own click would scroll the
  // toggle into view first and mask a scroll change.
  const toggle = page.locator(COLLAPSE_TOGGLE)
  const clickToggle = async () => {
    const box = await toggle.boundingBox()
    expect(box).not.toBeNull()
    // The harness toolbar scrolls with the page, so click the part of the toggle still on screen.
    const top = Math.max(box?.y ?? 0, 0)
    const bottom = (box?.y ?? 0) + (box?.height ?? 0)
    expect(bottom).toBeGreaterThan(top)
    await page.mouse.click(
      (box?.x ?? 0) + (box?.width ?? 0) / 2,
      (top + bottom) / 2,
    )
  }
  await clickToggle()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await page.waitForTimeout(150)
  const collapsed = await snapshot()
  expect(collapsed).toEqual(before)

  await clickToggle()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(150)
  expect(await snapshot()).toEqual(before)
})

test('Tab lands on the collapse toggle while the toolbar is collapsed', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html?wiki=enabled')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })
  const toggle = page.locator(COLLAPSE_TOGGLE)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  const focusedType = () =>
    page.evaluate(() => document.activeElement?.getAttribute('data-type'))

  // The toggle is the only toolbar stop: the Escape then Tab gesture from the editor reaches it
  // (task 456), and the arrow keys have nowhere else to go.
  await page.locator('.vditor-ir .vditor-reset').click()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  await expect.poll(focusedType).toBe('collapse-toolbar')
  await page.keyboard.press('ArrowRight')
  await expect.poll(focusedType).toBe('collapse-toolbar')
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(focusedType).toBe('collapse-toolbar')
})
